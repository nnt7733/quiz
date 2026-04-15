import React, { useState, useEffect, useRef } from 'react';
import {
  UploadCloud, BookOpen, BrainCircuit, Trophy, Settings,
  CheckCircle2, XCircle, Flame, Star,
  Play, Plus, Clock, FileText, ArrowRight, RefreshCw,
  AlertCircle, Info, Sparkles, Download, Cloud, Zap, ShieldAlert, Target,
  LogIn, LogOut, User, Key, ExternalLink, ChevronRight, Layers, TrendingUp,
  Sun, Moon, Square
} from 'lucide-react';
import {
  getFirestore, doc, setDoc, getDoc, collection,
  onSnapshot, updateDoc, deleteDoc, writeBatch
} from 'firebase/firestore';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from 'firebase/auth';
import { db, auth, googleProvider } from './firebase.js';

// ==========================================
// ⚙️ CONSTANTS
// ==========================================
const REALMS = [
  "☁️ Luyện Khí", "🌬️ Trúc Cơ", "🔮 Kết Đan", "👶 Nguyên Anh",
  "👁️ Hóa Thần", "🌌 Luyện Hư", "☯️ Hợp Thể", "👑 Đại Thừa",
  "⚡ Độ Kiếp", "✨ Tiên Nhân"
];
const XP_REWARDS = { easy: 5, medium: 10, hard: 20 };

// ==========================================
// 🔊 SOUND EFFECTS (Web Audio API)
// ==========================================
const createTone = (ctx, freq, type, duration) => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  gain.gain.setValueAtTime(0.3, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
};

const playSound = (type) => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (type === 'thunder') {
      createTone(ctx, 80, 'sawtooth', 0.6);
      setTimeout(() => createTone(ctx, 120, 'square', 0.3), 200);
    } else if (type === 'success') {
      [523, 659, 784, 1047].forEach((f, i) =>
        setTimeout(() => createTone(ctx, f, 'sine', 0.3), i * 100)
      );
    } else if (type === 'fail') {
      [300, 200, 150].forEach((f, i) =>
        setTimeout(() => createTone(ctx, f, 'square', 0.3), i * 150)
      );
    }
  } catch (e) { /* silent fail */ }
};

// ==========================================
// 🛠 UTILITIES
// ==========================================
const getLevelInfo = (level) => {
  if (level >= 90) return { name: "✨ Tiên Nhân", isMax: true, main: 9, sub: 0, subName: "Trường Sinh" };
  const main = Math.floor(level / 10);
  const sub = level % 10;
  const subName = sub === 9 ? "Viên Mãn" : `Tầng ${sub + 1}`;
  return { name: `${REALMS[main]} - ${subName}`, isMax: false, main, sub, subName };
};

const getXpReq = (level) => {
  if (level >= 90) return Infinity;
  return 100 * (level + 1);
};

const getBaseSuccessRate = (level) => {
  if (level >= 90) return 1.0;
  const main = Math.floor(level / 10);
  const sub = level % 10;
  if (sub === 9) {
    const realmRates = [1.0, 0.95, 0.85, 0.70, 0.50, 0.30, 0.15, 0.05, 0.01];
    return realmRates[main];
  }
  if (main === 0) return 1.0;
  const startRates = [1.0, 1.0, 0.90, 0.80, 0.70, 0.60, 0.50, 0.40, 0.30];
  const dropPerSub = 0.01 * main;
  return Math.max(0.01, startRates[main] - dropPerSub * sub);
};

const generateId = () => Math.random().toString(36).substr(2, 9);

// Firestore path helpers (per-user private data)
const docsCol = (uid) => `users/${uid}/documents`;
const questionsCol = (uid) => `users/${uid}/questions`;
const statsDoc = (uid) => `users/${uid}/stats/profile`;
const settingsDocPath = (uid) => `users/${uid}/settings/user`;

// ==========================================
// 🤖 AI API (Multi-provider)
// ==========================================
const fetchWithRetry = async (url, options, retries = 5) => {
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (i === retries - 1) return res;
    } catch (err) { if (i === retries - 1) throw err; }
    await new Promise(r => setTimeout(r, delays[i]));
  }
};

const generateText = async (prompt, cfg) => {
  const provider = cfg.provider || 'gemini';
  const apiKey = cfg.apiKey;
  if (!apiKey) throw new Error("Cần nhập API Key để sử dụng. Vào Cài đặt để thêm key.");

  if (provider === 'openai-compat') {
    const baseUrl = (cfg.customBaseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error("Cần nhập Base URL cho nhà cung cấp AI. Vào Cài đặt để thêm.");
    const modelId = cfg.customModelId || 'gpt-3.5-turbo';
    const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      })
    });
    if (!res.ok) {
      let errMsg = "Lỗi khi gọi AI. Kiểm tra API Key / Base URL hoặc thử lại sau.";
      try {
        const errData = await res.json();
        if (errData?.error?.message) errMsg = `Lỗi từ AI: ${errData.error.message}`;
      } catch(e) {}
      throw new Error(errMsg);
    }
    const data = await res.json();
    return data.choices[0].message.content;
  }

  // Default: Gemini provider
  const modelId = cfg.model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, responseMimeType: "application/json" },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    })
  });
  if (!res.ok) {
    let errMsg = "Lỗi khi gọi Khí Linh (AI). Kiểm tra API Key hoặc thử lại sau.";
    try {
      const errData = await res.json();
      if (errData?.error?.message) {
        if (errData.error.message.includes("Quota exceeded") || errData.error.message.includes("429")) {
          errMsg = "API Key đã hết lượt gọi miễn phí hoặc bị giới hạn. Hãy kiểm tra lại hoặc nạp thêm tài khoản.";
        } else {
          errMsg = `Lỗi từ AI: ${errData.error.message}`;
        }
      }
    } catch(e) {}
    throw new Error(errMsg);
  }
  const data = await res.json();
  if (data.candidates?.[0]?.finishReason === "SAFETY") {
    throw new Error("AI từ chối trả lời vì nội dung vi phạm an toàn.");
  }
  return data.candidates[0].content.parts[0].text;
};

const repairJSON = async (brokenText, cfg) => {
  const repairPrompt = `The following text was supposed to be a valid JSON array but has syntax errors. Fix it and return ONLY the corrected raw JSON array, nothing else:\n\n${brokenText}`;
  const fixed = await generateText(repairPrompt, cfg);
  const match = fixed.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("JSON repair failed");
  return JSON.parse(match[0]);
};

const safeParseJSONArray = async (rawText, cfg) => {
  const jsonMatch = rawText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return await repairJSON(rawText, cfg);
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error("not array");
    return parsed;
  } catch {
    return await repairJSON(jsonMatch[0], cfg);
  }
};

// ==========================================
// ⚛️ MAIN APP
// ==========================================
export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [currentScreen, setCurrentScreen] = useState('dashboard');

  // Cloud Data (per-user)
  const [documents, setDocuments] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [userStats, setUserStats] = useState({
    level: 0, xp: 0, failBonus: 0, streak: 0,
    lastLogin: null, history: [], wrongQs: []
  });
  const [settings, setSettings] = useState({
    apiKey: '', theme: 'dark', defaultCount: 10, model: 'gemini-2.5-flash', quizLanguage: 'auto',
    provider: 'gemini', customBaseUrl: '', customModelId: ''
  });
  const [activeSession, setActiveSession] = useState(null);
  const [sessionResult, setSessionResult] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [toast, setToast] = useState(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadText, setUploadText] = useState('');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingKey, setOnboardingKey] = useState('');

  // AI States
  const [summaryModal, setSummaryModal] = useState({ isOpen: false, isLoading: false, title: '', content: '' });
  const [mnemonicState, setMnemonicState] = useState({ isLoading: false, text: '' });
  const [tribulationModal, setTribulationModal] = useState({
    isOpen: false, targetLevel: null, successRate: 1,
    result: null, penaltyXp: 0, isStriking: false
  });
  const [quizSetupModal, setQuizSetupModal] = useState({ isOpen: false, chapter: null, chapterQs: [] });
  const [difficultySetupModal, setDifficultySetupModal] = useState({ isOpen: false, chapter: null, docData: null, mode: 'single' });
  const [difficultyDist, setDifficultyDist] = useState({ easy: 3, medium: 4, hard: 3 });

  // Background generation queue
  const [genQueue, setGenQueue] = useState([]);
  const processingRef = useRef(false);
  const [queueWidgetCollapsed, setQueueWidgetCollapsed] = useState(false);

  // Refs for latest state — used by async queue processors to avoid stale closures
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ——— AUTH ———
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  const handleGoogleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      showToast("Đăng nhập thất bại: " + err.message, "error");
    }
  };

  const handleSignOut = async () => {
    if (window.confirm("Xuất quan? Tu vi sẽ được lưu lại.")) {
      await signOut(auth);
      setCurrentScreen('dashboard');
    }
  };

  // ——— REALTIME DATA SYNC (per user) ———
  useEffect(() => {
    if (!user) return;
    const uid = user.uid;

    // Stats
    const sDoc = doc(db, statsDoc(uid));
    const unsubStats = onSnapshot(sDoc, async (snap) => {
      if (snap.exists()) {
        const stats = { ...snap.data() };
        if (stats.level === undefined) stats.level = 0;
        if (stats.failBonus === undefined) stats.failBonus = 0;
        if (stats.wrongQs === undefined) stats.wrongQs = [];

        const today = new Date().toDateString();
        if (stats.lastLogin !== today) {
          const yesterday = new Date(Date.now() - 86400000).toDateString();
          const newStreak = stats.lastLogin === yesterday ? stats.streak + 1 : 1;
          await updateDoc(sDoc, { streak: newStreak, lastLogin: today });
          stats.streak = newStreak;
          stats.lastLogin = today;
        }
        setUserStats(stats);
      } else {
        const initial = {
          level: 0, xp: 0, failBonus: 0, streak: 1,
          lastLogin: new Date().toDateString(), history: [], wrongQs: []
        };
        await setDoc(sDoc, initial);
        setUserStats(initial);
      }
    });

    // Documents
    const dCol = collection(db, docsCol(uid));
    const unsubDocs = onSnapshot(dCol, (snap) =>
      setDocuments(snap.docs.map(d => ({ ...d.data(), id: d.id })))
    );

    // Questions
    const qCol = collection(db, questionsCol(uid));
    const unsubQ = onSnapshot(qCol, (snap) =>
      setQuestions(snap.docs.map(d => ({ ...d.data(), id: d.id })))
    );

    // Settings
    const settDoc = doc(db, settingsDocPath(uid));
    const unsubSettings = onSnapshot(settDoc, (snap) => {
      if (snap.exists()) {
        const s = snap.data();
        setSettings(s);
        // Show onboarding if no API key
        if (!s.apiKey) {
          setShowOnboarding(true);
        }
      } else {
        // First time: show onboarding
        setShowOnboarding(true);
      }
    });

    return () => { unsubStats(); unsubDocs(); unsubQ(); unsubSettings(); };
  }, [user]);

  // Apply theme
  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
  }, [settings.theme]);

  // Quiz Hotkeys
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (currentScreen === 'quiz' && activeSession) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (activeSession.isChecking) {
            const nextBtn = document.getElementById('quiz-next-btn');
            if (nextBtn) nextBtn.click();
          } else {
            const checkBtn = document.getElementById('quiz-check-btn');
            if (checkBtn && !checkBtn.disabled) checkBtn.click();
          }
        } else if (!activeSession.isChecking) {
          const num = parseInt(e.key);
          const currentQ = activeSession.questions[activeSession.currentIndex];
          if (!isNaN(num) && num > 0 && num <= currentQ.options.length) {
            e.preventDefault();
            const optionKey = currentQ.options[num - 1].key;
            const optBtn = document.getElementById(`quiz-opt-${optionKey}`);
            if (optBtn) optBtn.click();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentScreen, activeSession]);

  // Auto-save session against F5
  useEffect(() => {
    if (activeSession) {
      localStorage.setItem('tu_tien_autosave', JSON.stringify(activeSession));
    } else {
      localStorage.removeItem('tu_tien_autosave');
    }
  }, [activeSession]);

  const showToast = (msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // ——— DATA OPERATIONS ———

  // Semantic segmentation using AI
  const segmentDocumentWithAI = async (text, cfg) => {
    const prompt = `[TASK] Bạn là chuyên gia phân tích tài liệu. Hãy chia đoạn văn bản sau thành các SEGMENTS (đoạn) có ý nghĩa hoàn chỉnh.
Mỗi segment phải chứa một nhóm ý tưởng/khái niệm liên quan chặt chẽ với nhau.
Kích thước mỗi segment tùy thuộc vào độ phức tạp nội dung — KHÔNG cần cố định.

VĂN BẢN:
---
${text.substring(0, 15000)}
---

RETURN FORMAT: RAW JSON array (KHÔNG markdown, KHÔNG \`\`\`):
[
  { "title": "Tiêu đề ngắn gọn cho đoạn", "content": "Toàn bộ nội dung gốc của đoạn, giữ nguyên 100%", "wordCount": 150 }
]

QUAN TRỌNG:
- Giữ nguyên 100% nội dung gốc, KHÔNG tóm tắt, KHÔNG thêm bớt
- Mỗi segment phải có ý nghĩa hoàn chỉnh
- Trả về ĐÚNG format JSON, không có ký tự bao quanh`;

    try {
      const rawRes = await generateText(prompt, cfg);
      const jsonMatch = rawRes.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("parse_failed");
      const segments = JSON.parse(jsonMatch[0]);
      return segments.map((seg, i) => ({
        id: generateId(),
        title: seg.title || `Đoạn ${i + 1}`,
        content: seg.content,
        wordCount: seg.wordCount || seg.content.split(/\s+/).length,
        exploitedAt: null,
        bloomLevel: 0
      }));
    } catch (e) {
      // Fallback: manual split by paragraphs
      const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 30);
      const segments = [];
      let current = { content: '', words: 0 };
      let idx = 0;
      for (const para of paragraphs) {
        const wc = para.split(/\s+/).length;
        current.content += (current.content ? '\n\n' : '') + para.trim();
        current.words += wc;
        if (current.words >= 150 || para === paragraphs[paragraphs.length - 1]) {
          segments.push({
            id: generateId(),
            title: `Đoạn ${idx + 1}`,
            content: current.content,
            wordCount: current.words,
            exploitedAt: null,
            bloomLevel: 0
          });
          current = { content: '', words: 0 };
          idx++;
        }
      }
      if (segments.length === 0) {
        segments.push({
          id: generateId(),
          title: 'Nội dung chung',
          content: text.trim(),
          wordCount: text.split(/\s+/).length,
          exploitedAt: null,
          bloomLevel: 0
        });
      }
      return segments;
    }
  };

  const saveDocToCloud = async (title, text) => {
    if (!user) return;
    if (!settings.apiKey) {
      showToast("Cần nhập API Key trước khi sử dụng. Vào Cài đặt để thêm.", "error");
      return;
    }
    setIsLoading(true); setLoadingMsg("Khí Linh đang phân tích cấu trúc tài liệu...");
    try {
      const segments = await segmentDocumentWithAI(text, settings);
      const docRef = doc(collection(db, docsCol(user.uid)));
      await setDoc(docRef, {
        title: title || "Tâm Pháp Mới",
        chapters: [{ id: generateId(), title: title || "Nội dung chính", content: text.trim(), segments }],
        createdAt: Date.now()
      });
      setUploadTitle(''); setUploadText('');
      setCurrentScreen('dashboard');
      showToast(`Ngọc Giản đã được chia thành ${segments.length} đoạn ngữ nghĩa!`, "success");
    } catch (err) {
      showToast("Lỗi: " + err.message, "error");
    } finally { setIsLoading(false); }
  };

  const handleDeleteDoc = async (docData) => {
    if (!user || !window.confirm('Hủy bỏ ngọc giản này? Toàn bộ câu hỏi cũng sẽ bị xóa.')) return;
    try {
      const batch = writeBatch(db);
      const chapterIds = docData.chapters.map(c => c.id);
      questions
        .filter(q => chapterIds.includes(q.chapterId))
        .forEach(q => batch.delete(doc(db, questionsCol(user.uid), q.id)));
      batch.delete(doc(db, docsCol(user.uid), docData.id));
      await batch.commit();
      showToast("Đã hủy Ngọc Giản và toàn bộ câu hỏi liên quan.", "success");
    } catch (err) {
      showToast("Lỗi khi xóa: " + err.message, "error");
    }
  };

  const handleDeleteChapter = async (chapter, docData) => {
    if (!user || !window.confirm(`Xóa bài "${chapter.title}"? Toàn bộ câu hỏi của bài này cũng sẽ bị xóa.`)) return;
    try {
      const batch = writeBatch(db);

      questions
        .filter(q => q.chapterId === chapter.id)
        .forEach(q => batch.delete(doc(db, questionsCol(user.uid), q.id)));

      const remainingChapters = (docData.chapters || []).filter(c => c.id !== chapter.id);
      const docRef = doc(db, docsCol(user.uid), docData.id);

      if (remainingChapters.length === 0) {
        batch.delete(docRef);
      } else {
        batch.update(docRef, { chapters: remainingChapters });
      }

      await batch.commit();
      showToast("Đã xóa bài khỏi Tàng Kinh Các.", "success");
    } catch (err) {
      showToast("Lỗi khi xóa bài: " + err.message, "error");
    }
  };

  // Open difficulty setup modal before generating
  const openDifficultySetup = (chapter, docData, mode = 'single') => {
    setDifficultySetupModal({ isOpen: true, chapter, docData, mode });
  };

  // Enqueue generation jobs (single segment or all remaining segments)
  const enqueueGeneration = (chapter, docData, dist, mode) => {
    if (!user || !settings.apiKey) {
      showToast("Cần nhập API Key để tạo câu hỏi.", "error");
      return;
    }
    const segments = chapter.segments || [];

    if (segments.length === 0) {
      const job = {
        id: generateId(), chapterId: chapter.id, chapterTitle: chapter.title,
        chapterContent: chapter.content, docId: docData.id, docData,
        type: 'segment-then-generate', dist: { ...dist }, mode, status: 'pending'
      };
      setGenQueue(prev => [...prev, job]);
      showToast(`Đã thêm "${chapter.title}" vào hàng đợi (cần phân đoạn trước).`, "info");
      return;
    }

    const pending = segments.filter(s => !s.exploitedAt);
    if (pending.length === 0) {
      showToast("Đã khai thác hết! Bấm nút 'Nâng Cao' để tạo câu hỏi đỉnh cao.", "info");
      return;
    }

    const targets = mode === 'all' ? pending : pending.slice(0, 1);

    // Dedup: skip segments already in queue
    const existingKeys = new Set(
      genQueue.filter(j => j.status === 'pending' || j.status === 'processing')
        .map(j => `${j.chapterId}::${j.segmentId}`)
    );
    const newTargets = targets.filter(seg => !existingKeys.has(`${chapter.id}::${seg.id}`));
    if (newTargets.length === 0) {
      showToast("Đã có trong hàng đợi rồi!", "info");
      return;
    }

    const jobs = newTargets.map(seg => ({
      id: generateId(), chapterId: chapter.id, chapterTitle: chapter.title,
      docId: docData.id, docData, segmentId: seg.id, segmentTitle: seg.title,
      segmentContent: seg.content,
      dist: { ...dist }, status: 'pending', type: 'generate'
    }));
    setGenQueue(prev => [...prev, ...jobs]);
    showToast(`Đã thêm ${jobs.length} đoạn vào hàng đợi tạo câu hỏi.`, "info");
  };

  // Process a single generation job — reads from refs to always get latest state
  const processOneJob = async (job) => {
    const s = settingsRef.current;
    const langInstruction = s.quizLanguage === 'vi'
      ? "[STRICT LANGUAGE INSTRUCTION]\nYou MUST output ALL content in VIETNAMESE language, strictly translating if the source is in another language."
      : s.quizLanguage === 'en'
        ? "[STRICT LANGUAGE INSTRUCTION]\nYou MUST output ALL content in ENGLISH language, strictly translating if the source is in another language."
        : "[STRICT LANGUAGE INSTRUCTION]\nYou MUST auto-detect the language of the NỘI DUNG below and output ALL content in the EXACT SAME LANGUAGE.";

    if (job.type === 'segment-then-generate') {
      const segments = await segmentDocumentWithAI(job.chapterContent, s);
      const freshDoc = documentsRef.current.find(d => d.id === job.docId);
      if (!freshDoc) throw new Error("Tài liệu không còn tồn tại.");
      const updatedChapters = freshDoc.chapters.map(c =>
        c.id === job.chapterId ? { ...c, segments } : c
      );
      await updateDoc(doc(db, docsCol(user.uid), job.docId), { chapters: updatedChapters });

      const pending = segments.filter(seg => !seg.exploitedAt);
      const targets = job.mode === 'all' ? pending : pending.slice(0, 1);
      const followUpJobs = targets.map(seg => ({
        id: generateId(), chapterId: job.chapterId, chapterTitle: job.chapterTitle,
        docId: job.docId, docData: { ...freshDoc, chapters: updatedChapters },
        segmentId: seg.id, segmentTitle: seg.title, segmentContent: seg.content,
        dist: { ...job.dist }, status: 'pending', type: 'generate'
      }));
      setGenQueue(prev => [...prev, ...followUpJobs]);
      return { questionsCreated: 0, message: `Đã phân thành ${segments.length} đoạn, đang xếp hàng tạo câu hỏi...` };
    }

    // type === 'generate' — read latest questions to avoid duplicates
    const existingText = questionsRef.current
      .filter(q => q.chapterId === job.chapterId)
      .map(q => `- ${q.question}`).join("\n");

    const isShort = (job.segmentContent || '').length < 300;
    const dist = { ...job.dist };
    let totalQs = dist.easy + dist.medium + dist.hard;
    if (isShort) {
      const cap = Math.min(totalQs, 3);
      const ratio = cap / Math.max(totalQs, 1);
      dist.easy = Math.max(1, Math.round(dist.easy * ratio));
      dist.medium = Math.max(0, Math.round(dist.medium * ratio));
      dist.hard = Math.max(0, cap - dist.easy - dist.medium);
      totalQs = dist.easy + dist.medium + dist.hard;
    }

    const coverageRule = isShort
      ? `1. Tạo tối đa ${totalQs} câu hỏi trắc nghiệm dựa trên đoạn trên (có thể ít hơn nếu không đủ nội dung).`
      : `1. Tạo ĐÚNG ${totalQs} câu hỏi trắc nghiệm bao phủ MỌI chi tiết trong đoạn trên.`;
    const difficultyRule = isShort
      ? `2. Phân bổ ĐỘ KHÓ (linh hoạt):
   - Tối đa ${dist.easy} câu difficulty="easy"
   - Tối đa ${dist.medium} câu difficulty="medium"
   - Tối đa ${dist.hard} câu difficulty="hard"`
      : `2. Phân bổ ĐỘ KHÓ (BẮTBUỘC):
   - ĐÚNG ${dist.easy} câu difficulty="easy" (Nhớ/Remember): Định nghĩa, liệt kê, nhận diện sự kiện
   - ĐÚNG ${dist.medium} câu difficulty="medium" (Hiểu/Understand): Giải thích, so sánh, tóm tắt ý nghĩa
   - ĐÚNG ${dist.hard} câu difficulty="hard" (Vận dụng/Apply+Analyze): Áp dụng, phân tích, đánh giá`;

    const prompt = `${langInstruction}

[ROLE] Educational Expert using Bloom's Taxonomy Levels 1-3.

[NỘI DUNG ĐOẠN CẦN KHAI THÁC]
---
${job.segmentContent}
---

[CÂU HỎI ĐÃ TỒN TẠI — TUYỆT ĐỐI KHÔNG TRÙNG]
${existingText || "Chưa có câu nào."}

[YÊU CẦU]
${coverageRule}
${difficultyRule}
3. Cả "single" và "multiple" answer types.
4. KHÔNG tạo câu giống hoặc tương tự danh sách đã có ở trên.
5. Giải thích chi tiết cho mỗi câu.

RETURN FORMAT: RAW JSON array (NO markdown):
[
  {
    "id": "random_id",
    "question": "Question text?",
    "type": "single",
    "difficulty": "easy",
    "bloomLevel": 1,
    "options": [
      { "key": "A", "text": "Option 1" },
      { "key": "B", "text": "Option 2" },
      { "key": "C", "text": "Option 3" },
      { "key": "D", "text": "Option 4" }
    ],
    "correctAnswers": ["A"],
    "explanation": "Detailed explanation...",
    "citation": { "text": "Quote from text", "chapter": "${job.chapterTitle}" },
    "tags": ["keyword1"]
  }
]`;

    const rawRes = await generateText(prompt, s);
    const newQsRaw = await safeParseJSONArray(rawRes, s);
    if (newQsRaw.length === 0) throw new Error("Không tạo được câu hỏi cho đoạn này.");

    const batch = writeBatch(db);
    for (const qData of newQsRaw) {
      const qRef = doc(collection(db, questionsCol(user.uid)));
      batch.set(qRef, { ...qData, chapterId: job.chapterId, segmentId: job.segmentId, id: qRef.id });
    }

    // Read latest documents to avoid overwriting other jobs' segment tracking
    const freshDoc = documentsRef.current.find(d => d.id === job.docId);
    if (freshDoc) {
      const chapter = freshDoc.chapters.find(c => c.id === job.chapterId);
      if (chapter) {
        const updatedSegments = (chapter.segments || []).map(seg =>
          seg.id === job.segmentId ? { ...seg, exploitedAt: Date.now(), bloomLevel: 3 } : seg
        );
        const updatedChapters = freshDoc.chapters.map(c =>
          c.id === job.chapterId ? { ...c, segments: updatedSegments } : c
        );
        batch.update(doc(db, docsCol(user.uid), job.docId), { chapters: updatedChapters });
      }
    }

    await batch.commit();
    return { questionsCreated: newQsRaw.length };
  };

  // Queue processor effect
  useEffect(() => {
    if (processingRef.current) return;
    const nextJob = genQueue.find(j => j.status === 'pending');
    if (!nextJob) return;

    processingRef.current = true;
    setGenQueue(prev => prev.map(j => j.id === nextJob.id ? { ...j, status: 'processing' } : j));

    const jobFn = nextJob.type === 'advanced' ? processAdvancedJob : processOneJob;
    jobFn(nextJob).then((result) => {
      setGenQueue(prev => prev.map(j => j.id === nextJob.id ? { ...j, status: 'done', result } : j));
      if (result.questionsCreated > 0) {
        showToast(`Tạo ${result.questionsCreated} câu cho "${nextJob.segmentTitle || nextJob.chapterTitle}"`, "success");
      } else if (result.message) {
        showToast(result.message, "info");
      }
    }).catch((err) => {
      setGenQueue(prev => prev.map(j => j.id === nextJob.id ? { ...j, status: 'error', error: err.message } : j));
      showToast(`Lỗi "${nextJob.segmentTitle || nextJob.chapterTitle}": ${err.message}`, "error");
    }).finally(() => {
      processingRef.current = false;
      // Trigger re-check for next pending job
      setGenQueue(prev => [...prev]);
    });
  }, [genQueue]);

  // Auto-dismiss completed queue after 4s — only if no errors remain
  useEffect(() => {
    const hasPendingOrProcessing = genQueue.some(j => j.status === 'pending' || j.status === 'processing');
    const hasErrors = genQueue.some(j => j.status === 'error');
    const hasFinished = genQueue.some(j => j.status === 'done' || j.status === 'cancelled');
    if (!hasPendingOrProcessing && hasFinished && !hasErrors) {
      const timer = setTimeout(() => setGenQueue([]), 4000);
      return () => clearTimeout(timer);
    }
  }, [genQueue]);

  // Advanced mode: Bloom L4-L6 + Extended questions (also uses queue now)
  const handleAdvancedQuestions = (chapter, docData) => {
    if (!user || !settings.apiKey) return;
    const job = {
      id: generateId(), chapterId: chapter.id, chapterTitle: chapter.title,
      chapterContent: chapter.content, docId: docData.id, docData,
      type: 'advanced', status: 'pending'
    };
    setGenQueue(prev => [...prev, job]);
    showToast(`Đã thêm "${chapter.title}" (Nâng Cao) vào hàng đợi.`, "info");
  };

  // Process advanced job — reads from refs to always get latest state
  const processAdvancedJob = async (job) => {
    const s = settingsRef.current;
    const langInstruction = s.quizLanguage === 'vi'
      ? "[STRICT LANGUAGE INSTRUCTION]\nYou MUST output ALL content in VIETNAMESE language, strictly translating if the source is in another language."
      : s.quizLanguage === 'en'
        ? "[STRICT LANGUAGE INSTRUCTION]\nYou MUST output ALL content in ENGLISH language, strictly translating if the source is in another language."
        : "[STRICT LANGUAGE INSTRUCTION]\nYou MUST auto-detect the language of the NỘI DUNG below and output ALL content in the EXACT SAME LANGUAGE.";

    const existingText = questionsRef.current
      .filter(q => q.chapterId === job.chapterId)
      .map(q => `- ${q.question}`).join("\n");

    const prompt = `${langInstruction}

[ROLE] Expert Educator — Bloom's Taxonomy Levels 4-6 + Knowledge Extension.

[TOÀN BỘ NỘI DUNG TÀI LIỆU]
---
${job.chapterContent.substring(0, 15000)}
---

[CÂU HỎI ĐÃ TỒN TẠI — TUYỆT ĐỐI KHÔNG TRÙNG]
${existingText || "None"}

[YÊU CẦU]
Tạo các câu hỏi NÂNG CAO, linh hoạt chia thành 2 nhóm:

NHÓM 1 — Bloom L4-L6 (Khai thác tối đa từ nội dung tài liệu):
- Các câu hỏi Phân tích (Analyze): Tìm mối quan hệ, phân biệt nguyên nhân-hệ quả.
- Các câu hỏi Đánh giá (Evaluate): Đánh giá quan điểm, bảo vệ/phản biện lập luận.
- Các câu hỏi Sáng tạo (Create): Đề xuất giải pháp mới, thiết kế phương án.

NHÓM 2 — Mở rộng kiến thức:
- Dựa trên NỘI DUNG tài liệu, tìm các kiến thức LIÊN QUAN MẬT THIẾT mà tài liệu chưa đề cập đến để mở rộng giới hạn hiểu biết.

RETURN FORMAT: RAW JSON array (NO markdown):
[
  {
    "id": "random_id",
    "question": "Advanced question?",
    "type": "single",
    "difficulty": "hard",
    "bloomLevel": 4,
    "isExtended": false,
    "options": [
      { "key": "A", "text": "Option 1" },
      { "key": "B", "text": "Option 2" },
      { "key": "C", "text": "Option 3" },
      { "key": "D", "text": "Option 4" }
    ],
    "correctAnswers": ["A"],
    "explanation": "Detailed explanation with reasoning...",
    "citation": { "text": "Source reference", "chapter": "${job.chapterTitle}" },
    "tags": ["keyword1"]
  }
]`;

    const rawRes = await generateText(prompt, s);
    const newQsRaw = await safeParseJSONArray(rawRes, s);
    if (newQsRaw.length === 0) throw new Error("Không tạo được câu hỏi nâng cao.");

    const batch = writeBatch(db);
    for (const qData of newQsRaw) {
      const qRef = doc(collection(db, questionsCol(user.uid)));
      batch.set(qRef, { ...qData, chapterId: job.chapterId, id: qRef.id });
    }
    await batch.commit();
    return { questionsCreated: newQsRaw.length };
  };

  const handleGenerateSummary = async (chapter) => {
    setSummaryModal({ isOpen: true, isLoading: true, title: chapter.title, content: '' });
    try {
      const langInstruction = settings.quizLanguage === 'vi'
        ? "[STRICT LANGUAGE INSTRUCTION]\nYou MUST output ALL content in VIETNAMESE language."
        : settings.quizLanguage === 'en'
          ? "[STRICT LANGUAGE INSTRUCTION]\nYou MUST output ALL content in ENGLISH language."
          : "[STRICT LANGUAGE INSTRUCTION]\nYou MUST generate the summary in the EXACT SAME LANGUAGE as the source text below.";

      const prompt = `${langInstruction}
Role: AI Tutor. Summarize the key points using bullet points and bold keywords.
Chapter Content:\n${chapter.content.substring(0, 15000)}`;
      const text = await generateText(prompt, settings);
      setSummaryModal({ isOpen: true, isLoading: false, title: chapter.title, content: text });
    } catch (err) {
      setSummaryModal({ isOpen: false, isLoading: false, title: '', content: '' });
      showToast("Không thể tạo tóm tắt: " + err.message, "error");
    }
  };

  const handleGenerateMnemonic = async (currentQ) => {
    setMnemonicState({ isLoading: true, text: '' });
    const correctText = currentQ.correctAnswers
      .map(k => currentQ.options.find(o => o.key === k)?.text).join(', ');
    try {
      const langInstruction = settings.quizLanguage === 'vi'
        ? "[STRICT LANGUAGE INSTRUCTION]\nYou MUST output the mnemonic in VIETNAMESE language."
        : settings.quizLanguage === 'en'
          ? "[STRICT LANGUAGE INSTRUCTION]\nYou MUST output the mnemonic in ENGLISH language."
          : "[STRICT LANGUAGE INSTRUCTION]\nGenerate the mnemonic in the EXACT SAME LANGUAGE as the question below.";

      const prompt = `${langInstruction}
Question: "${currentQ.question}"
Correct Answer: "${correctText}"
Explanation: "${currentQ.explanation}"
Task: Create a memorable MNEMONIC (acronym, funny mental image, or rhyme). Keep it short and direct.`;
      const text = await generateText(prompt, settings);
      setMnemonicState({ isLoading: false, text });
    } catch (err) {
      setMnemonicState({ isLoading: false, text: '' });
      showToast("Không thể lĩnh ngộ mẹo: " + err.message, "error");
    }
  };

  // ——— EXPORT / IMPORT ———
  const handleExportData = () => {
    const data = { documents, questions, userStats, exportedAt: Date.now() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `TuTienLo_Backup_${new Date().getTime()}.json`; a.click();
    URL.revokeObjectURL(url);
    showToast("Đã xuất toàn bộ dữ liệu!", "success");
  };

  const handleImportData = (e) => {
    const file = e.target.files[0];
    if (!file || !user) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast("Bí kíp nguyên thần quá nặng (>5MB), không thể dung hợp!", "error");
      e.target.value = null;
      return;
    }
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        setIsLoading(true); setLoadingMsg("Đang dung hợp Nguyên Thần và Bí Kíp...");
        const imported = JSON.parse(evt.target.result);
        if (!imported.documents || !imported.questions) throw new Error("Định dạng file không đúng.");
        const batch = writeBatch(db);
        imported.documents.forEach(d => batch.set(doc(db, docsCol(user.uid), d.id), d));
        imported.questions.forEach(q => batch.set(doc(db, questionsCol(user.uid), q.id), q));
        await batch.commit();
        if (imported.userStats) await setDoc(doc(db, statsDoc(user.uid)), imported.userStats, { merge: true });
        showToast("Dung hợp thành công!", "success");
      } catch (err) { showToast("Lỗi: " + err.message, "error"); }
      finally { setIsLoading(false); e.target.value = null; }
    };
    reader.readAsText(file);
  };

  // ——— QUIZ ———
  const startQuiz = (mode, chapterId, chapterQs) => {
    let selectedQs = [];
    const shuffled = [...chapterQs].sort(() => 0.5 - Math.random());
    if (mode === 'standard') selectedQs = shuffled.slice(0, settings.defaultCount);
    else if (mode === 'all') selectedQs = shuffled;
    else if (mode === 'review') selectedQs = shuffled.filter(q => userStats.wrongQs?.includes(q.id));
    else if (mode === 'review_session') selectedQs = shuffled;

    setActiveSession({
      chapterId, questions: selectedQs, currentIndex: 0,
      userAnswers: {}, isChecking: false, score: 0,
      startTime: Date.now(), xpGained: 0, wrongInSession: [], correctInSession: []
    });
    setMnemonicState({ isLoading: false, text: '' });
    setQuizSetupModal({ isOpen: false, chapter: null, chapterQs: [] });
    setCurrentScreen('quiz');
  };

  // ——— ĐỘ KIẾP ———
  const handleOpenTribulation = () => {
    const baseRate = getBaseSuccessRate(userStats.level);
    const actualRate = Math.min(1.0, baseRate + userStats.failBonus);
    setTribulationModal({
      isOpen: true, targetLevel: getLevelInfo(userStats.level + 1),
      successRate: actualRate, result: null, penaltyXp: 0, isStriking: false
    });
  };

  const handleDoKiep = () => {
    setTribulationModal(prev => ({ ...prev, isStriking: true }));
    playSound('thunder');
    setTimeout(async () => {
      const isSuccess = Math.random() <= tribulationModal.successRate;
      const sDoc = doc(db, statsDoc(user.uid));
      if (isSuccess) {
        playSound('success');
        const xpReq = getXpReq(userStats.level);
        await updateDoc(sDoc, { level: userStats.level + 1, xp: Math.max(0, userStats.xp - xpReq), failBonus: 0 });
        setTribulationModal(prev => ({ ...prev, result: 'success', isStriking: false }));
      } else {
        playSound('fail');
        const penaltyXp = Math.floor(userStats.xp * 0.5);
        await updateDoc(sDoc, { xp: userStats.xp - penaltyXp, failBonus: userStats.failBonus + 0.05 });
        setTribulationModal(prev => ({ ...prev, result: 'fail', penaltyXp, isStriking: false }));
      }
    }, 2000);
  };

  const updateSettings = async (newSettings) => {
    if (!user) return;
    const merged = { ...settings, ...newSettings };
    await setDoc(doc(db, settingsDocPath(user.uid)), merged, { merge: true });
  };

  const handleOnboardingSubmit = async () => {
    if (!onboardingKey.trim()) {
      showToast("Vui lòng nhập API Key để tiếp tục.", "error");
      return;
    }
    await updateSettings({ apiKey: onboardingKey.trim() });
    setShowOnboarding(false);
    showToast("Chào mừng đến Tu Tiên Lộ! API Key đã được lưu.", "success");
  };

  // ==========================================
  // 🖥 UI RENDERERS
  // ==========================================

  // ——— LOGIN SCREEN ———
  const renderLogin = () => (
    <div className="min-h-screen flex items-center justify-center mesh-gradient p-4">
      <div className="max-w-md w-full text-center">
        <div className="glass-card rounded-3xl p-10 shadow-2xl animate-scale-in">
          <div className="bg-gradient-to-br from-rose-500 to-fuchsia-600 p-4 rounded-2xl border border-rose-300/30 inline-block mb-6 glow-pink animate-float">
            <Zap className="w-12 h-12 text-gray-900 dark:text-white" />
          </div>
          <h1 className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-rose-400 to-fuchsia-400 mb-3 uppercase tracking-wider text-glow-pink">
            Tu Tiên Lộ
          </h1>
          <p className="text-gray-400 mb-10 leading-relaxed">
            Hệ thống ôn thi thông minh theo phong cách tu tiên.<br />
            Đăng nhập để bắt đầu hành trình tu luyện của bạn.
          </p>
          <button
            onClick={handleGoogleSignIn}
            className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-100 text-gray-800 font-bold py-4 rounded-xl text-lg transition-all transform hover:-translate-y-1 shadow-lg hover:shadow-xl"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Đăng nhập bằng Google
          </button>
          <p className="text-xs text-gray-600 mt-6">🔒 Dữ liệu của bạn được bảo mật và lưu riêng cho từng tài khoản</p>
        </div>
      </div>
    </div>
  );

  // ——— ONBOARDING MODAL ———
  const renderOnboarding = () => (
    <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-[300] flex items-center justify-center p-4 animate-fade-in">
      <div className="glass-card rounded-3xl p-8 md:p-10 max-w-lg w-full shadow-2xl border border-rose-500/20 animate-scale-in">
        <div className="text-center mb-8">
          <div className="bg-gradient-to-br from-rose-500 to-fuchsia-600 p-4 rounded-2xl inline-block mb-4 glow-pink">
            <Key className="w-10 h-10 text-gray-900 dark:text-white" />
          </div>
          <h2 className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-rose-400 to-fuchsia-400 mb-2">
            Chào mừng Đạo Hữu!
          </h2>
          <p className="text-gray-400 leading-relaxed">
            Để sử dụng Khí Linh (AI) tạo câu hỏi, bạn cần cung cấp <strong className="text-rose-400">Gemini API Key</strong>.
          </p>
        </div>

        <div className="space-y-4 mb-8">
          <div className="flex items-start gap-3 bg-rose-50 dark:bg-white/5 p-4 rounded-xl border border-rose-200/40 dark:border-white/10">
            <span className="bg-rose-500/20 text-rose-400 rounded-full w-7 h-7 flex items-center justify-center font-bold text-sm flex-shrink-0">1</span>
            <div>
              <p className="text-gray-900 dark:text-white font-medium">Truy cập Google AI Studio</p>
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer"
                className="text-rose-400 hover:text-rose-300 text-sm flex items-center gap-1 mt-1 transition-colors">
                aistudio.google.com/apikey <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
          <div className="flex items-start gap-3 bg-rose-50 dark:bg-white/5 p-4 rounded-xl border border-rose-200/40 dark:border-white/10">
            <span className="bg-rose-500/20 text-rose-400 rounded-full w-7 h-7 flex items-center justify-center font-bold text-sm flex-shrink-0">2</span>
            <p className="text-gray-900 dark:text-white font-medium">Bấm "Create API Key" → Chọn project → Copy key</p>
          </div>
          <div className="flex items-start gap-3 bg-rose-50 dark:bg-white/5 p-4 rounded-xl border border-rose-200/40 dark:border-white/10">
            <span className="bg-rose-500/20 text-rose-400 rounded-full w-7 h-7 flex items-center justify-center font-bold text-sm flex-shrink-0">3</span>
            <p className="text-gray-900 dark:text-white font-medium">Dán key vào ô bên dưới</p>
          </div>
        </div>

        <input
          type="password"
          value={onboardingKey}
          onChange={e => setOnboardingKey(e.target.value)}
          placeholder="Dán API Key tại đây..."
          className="w-full px-5 py-4 rounded-xl bg-rose-100/50 dark:bg-white/10 border border-white/20 text-gray-900 dark:text-white placeholder-gray-500 focus:ring-2 focus:ring-rose-500 focus:border-transparent outline-none mb-4 transition-all"
        />

        <button
          onClick={handleOnboardingSubmit}
          className="w-full bg-gradient-to-r from-rose-500 to-fuchsia-600 hover:from-rose-400 hover:to-fuchsia-500 text-gray-900 dark:text-white font-bold py-4 rounded-xl text-lg transition-all transform hover:-translate-y-1 shadow-lg glow-pink"
        >
          Bắt Đầu Tu Luyện
        </button>

        <p className="text-center text-xs text-gray-500 mt-4">
          ⚡ API Key miễn phí — 15 requests/phút — Key được lưu riêng cho tài khoản của bạn
        </p>
      </div>
    </div>
  );

  // ——— HEADER ———
  const renderHeader = () => (
    <header className="glass-header sticky top-0 z-10 transition-colors">
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setCurrentScreen('dashboard')}>
          <div className="bg-gradient-to-br from-rose-500 to-fuchsia-600 p-2 rounded-xl border border-rose-400/30">
            <Zap className="w-6 h-6 text-gray-900 dark:text-white" />
          </div>
          <span className="font-bold text-xl bg-clip-text text-transparent bg-gradient-to-r from-rose-400 to-fuchsia-400 uppercase tracking-wider">
            Tu Tiên Lộ
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden md:flex items-center gap-3 glass-card px-4 py-1.5 rounded-full text-sm">
            <span className="flex items-center gap-1.5 text-orange-400 font-medium"><Flame className="w-4 h-4" /> {userStats.streak}</span>
            <div className="w-px h-4 bg-rose-100/50 dark:bg-white/10"></div>
            <span className="flex items-center gap-1.5 text-amber-400 font-medium"><Star className="w-4 h-4" /> {userStats.xp}</span>
          </div>
          {user?.photoURL && (
            <img src={user.photoURL} referrerPolicy="no-referrer" alt="avatar" className="w-8 h-8 rounded-full border-2 border-rose-400" />
          )}
          <button onClick={() => updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })} className="p-2 text-gray-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-white/5 rounded-full transition-colors" title="Đổi giao diện Sáng/Tối">
            {settings.theme === 'dark' ? <Moon className="w-5 h-5 text-indigo-300" /> : <Sun className="w-5 h-5 text-amber-500" />}
          </button>
          <button onClick={() => setCurrentScreen('upload')} className="p-2 text-gray-400 hover:text-rose-400 hover:bg-rose-50 dark:bg-white/5 rounded-full transition-colors"><Plus className="w-5 h-5" /></button>
          <button onClick={() => setCurrentScreen('settings')} className="p-2 text-gray-400 hover:text-rose-400 hover:bg-rose-50 dark:bg-white/5 rounded-full transition-colors"><Settings className="w-5 h-5" /></button>
          <button onClick={handleSignOut} className="p-2 text-gray-400 hover:text-red-400 hover:bg-rose-50 dark:bg-white/5 rounded-full transition-colors" title="Xuất quan"><LogOut className="w-5 h-5" /></button>
        </div>
      </div>
    </header>
  );

  // ——— DASHBOARD ———
  const renderDashboard = () => {
    const lvlInfo = getLevelInfo(userStats.level);
    const xpReq = getXpReq(userStats.level);
    const isReadyForBreakthrough = userStats.xp >= xpReq && !lvlInfo.isMax;
    const progressPercent = lvlInfo.isMax ? 100 : Math.min(100, (userStats.xp / xpReq) * 100);

    let totalAnswered = 0, correctAnswers = 0;
    userStats.history.forEach(h => { totalAnswered += h.questions.length; correctAnswers += h.score; });
    const accuracy = totalAnswered > 0 ? Math.round((correctAnswers / totalAnswered) * 100) : 0;

    return (
      <div className="max-w-7xl mx-auto px-4 py-8 animate-fade-in">
        {/* Autosave Resume Banner */}
        {localStorage.getItem('tu_tien_autosave') && (
          <div className="bg-amber-500/10 border border-amber-500/40 p-5 rounded-2xl mb-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 animate-scale-in shadow-xl relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 to-transparent pointer-events-none group-hover:from-amber-500/20 transition-all"></div>
            <div className="flex items-center gap-4 relative z-10">
              <div className="p-3 bg-amber-500/20 rounded-xl relative">
                <div className="absolute inset-0 bg-amber-400 blur-md opacity-30 group-hover:opacity-60 transition-opacity"></div>
                <Zap className="w-8 h-8 text-amber-500 animate-pulse relative z-10" />
              </div>
              <div>
                <p className="text-amber-500 font-black text-lg mb-0.5 tracking-tight">Cảnh Giới Bất Ổn!</p>
                <p className="text-sm text-gray-600 dark:text-gray-300 font-medium">Khí linh phát hiện ngài dở dang lần luyện hóa trước. Muốn tiếp tục độ kiếp không?</p>
              </div>
            </div>
            <div className="flex gap-3 w-full sm:w-auto relative z-10">
              <button 
                onClick={() => { 
                  try {
                    setActiveSession(JSON.parse(localStorage.getItem('tu_tien_autosave')));
                    setCurrentScreen('quiz');
                  } catch(e) { 
                    localStorage.removeItem('tu_tien_autosave'); 
                    showToast('Khí linh từ chối dữ liệu hỏng!', 'error');
                  }
                }} 
                className="flex-1 sm:flex-none px-6 py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-gray-900 rounded-xl font-bold shadow-lg transition-transform hover:-translate-y-1 hover:shadow-amber-500/25">Tiếp Tục</button>
              <button 
                onClick={() => { 
                  localStorage.removeItem('tu_tien_autosave'); 
                  showToast('Đã dung luyện tàn dư để dọn dẹp.', 'info');
                }} 
                className="px-5 py-2.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 hover:text-rose-400 rounded-xl font-bold border border-rose-500/30 transition-all hover:shadow-lg">Diệt Yêu</button>
            </div>
          </div>
        )}

        {/* Cultivation Card */}
        <div className={`rounded-3xl p-6 md:p-8 text-gray-900 dark:text-white shadow-2xl mb-8 relative overflow-hidden border transition-all duration-500
          ${isReadyForBreakthrough
            ? 'bg-gradient-to-r from-amber-600 to-orange-600 border-amber-400 glow-amber'
            : lvlInfo.isMax
              ? 'bg-gradient-to-r from-blue-900 to-purple-900 border-cyan-400'
              : 'bg-gradient-to-r from-rose-900/80 to-fuchsia-900/60 border-rose-500/30 glass-card'}`}>
          <div className="absolute right-0 top-0 opacity-10 w-64 h-64 transform translate-x-16 -translate-y-16">
            {lvlInfo.isMax ? <Cloud className="w-full h-full text-cyan-300" /> : <Zap className="w-full h-full text-rose-300" />}
          </div>
          <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-6 w-full md:w-auto">
              <div className={`w-24 h-24 bg-black/40 rounded-full border-2 flex items-center justify-center backdrop-blur-sm text-4xl
                ${isReadyForBreakthrough ? 'border-white animate-pulse glow-amber' : 'border-rose-400 glow-pink'}`}>
                {lvlInfo.name.split(" ")[0]}
              </div>
              <div className="flex-1">
                <p className="text-[#993556] dark:text-rose-200 font-semibold mb-1 tracking-widest uppercase text-xs">Cảnh Giới Hiện Tại</p>
                <h1 className="text-3xl md:text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-[#72243E] to-[#72243E] dark:from-rose-200 dark:to-fuchsia-300 drop-shadow-md">
                  {lvlInfo.name.substring(2)}
                </h1>
                <p className="text-sm font-medium text-[#72243E] dark:text-rose-100/70 flex items-center gap-1">
                  {user?.displayName && <span>{user.displayName} · </span>}
                  Bế quan liên tục {userStats.streak} ngày 🔥
                </p>
              </div>
            </div>
            <div className="w-full md:w-1/3 flex flex-col justify-center">
              {!isReadyForBreakthrough && !lvlInfo.isMax ? (
                <>
                  <div className="flex justify-between text-sm mb-2 font-bold text-[#4A1528] dark:text-rose-300">
                    <span>Tu vi: {userStats.xp}</span><span>{xpReq}</span>
                  </div>
                  <div className="h-4 bg-black/50 rounded-full overflow-hidden border border-rose-500/30">
                    <div className="h-full bg-gradient-to-r from-rose-500 to-fuchsia-500 transition-all duration-1000 relative progress-shimmer" style={{ width: `${progressPercent}%` }}>
                      <div className="absolute top-0 right-0 bottom-0 w-2 bg-rose-50 dark:bg-white/50 blur-[2px]"></div>
                    </div>
                  </div>
                  <p className="text-right font-medium text-xs mt-2 text-[#993556] dark:text-rose-200/70">Còn {xpReq - userStats.xp} tu vi nữa</p>
                </>
              ) : isReadyForBreakthrough ? (
                <div className="text-center animate-fade-in-up">
                  <p className="text-amber-100 mb-3 font-medium">Bình cảnh đã xuất hiện!</p>
                  <button onClick={handleOpenTribulation} className="w-full bg-gradient-to-r from-amber-400 to-amber-300 hover:from-amber-300 hover:to-amber-200 text-amber-900 font-black py-4 rounded-xl shadow-lg transform hover:-translate-y-1 transition-all flex items-center justify-center gap-2">
                    <Zap className="w-5 h-5" /> Trùng Kích Cảnh Giới
                  </button>
                </div>
              ) : (
                <div className="text-center">
                  <h3 className="text-2xl font-black text-cyan-300 tracking-widest">THỌ TỀ THIÊN ĐỊA</h3>
                  <p className="text-cyan-100 text-sm mt-2">Tu vi vô lượng: {userStats.xp}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: "Tâm Ma", val: userStats.wrongQs.length, icon: Target, color: "text-[#D4537E] dark:text-red-400", bg: "bg-red-500/10 border-red-500/20" },
            { label: "Đạo Tâm", val: `${accuracy}%`, icon: Trophy, color: "text-[#D4537E] dark:text-amber-400", bg: "bg-amber-500/10 border-amber-500/20" },
            { label: "Tổng Tu Vi", val: userStats.xp, icon: Star, color: "text-[#D4537E] dark:text-fuchsia-400", bg: "bg-fuchsia-500/10 border-fuchsia-500/20" },
            { label: "Ngộ Đạo", val: `+${(userStats.failBonus * 100).toFixed(0)}%`, icon: BrainCircuit, color: "text-[#D4537E] dark:text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" }
          ].map((stat, i) => (
            <div key={i} className="glass-card p-5 rounded-2xl border border-rose-200/30 dark:border-white/5 flex items-center gap-4 hover:border-rose-500/30 transition-all glow-pink-hover">
              <div className={`p-3 rounded-xl border ${stat.bg} ${stat.color}`}><stat.icon className="w-6 h-6" /></div>
              <div><p className="text-sm font-medium text-[#444441] dark:text-gray-400">{stat.label}</p><p className="text-[22px] font-semibold text-[#2C2C2A] dark:text-white">{stat.val}</p></div>
            </div>
          ))}
        </div>

        {/* Documents — Tàng Kinh Các */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-2xl font-semibold text-[#2C2C2A] dark:text-white flex items-center gap-2"><BookOpen className="text-[#D4537E] dark:text-rose-400" /> Tàng Kinh Các</h2>
          <button onClick={() => setCurrentScreen('upload')} className="flex items-center gap-2 text-sm font-bold text-[#D4537E] dark:text-rose-400 hover:bg-rose-500/10 px-4 py-2 rounded-lg transition-colors">
            <Plus className="w-4 h-4" /> Khắc Ngọc Giản
          </button>
        </div>

        {documents.length === 0 ? (
          <div className="text-center py-16 glass-card rounded-3xl border border-dashed border-rose-200/40 dark:border-white/10">
            <Cloud className="w-16 h-16 text-gray-600 mx-auto mb-4" />
            <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2">Tàng Kinh Các đang trống</h3>
            <p className="text-gray-500 mb-6">Hãy dán tâm pháp (tài liệu) để Khí Linh diễn hóa thành bài khảo nghiệm.</p>
            <button onClick={() => setCurrentScreen('upload')} className="px-8 py-3 bg-gradient-to-r from-rose-500 to-fuchsia-600 text-gray-900 dark:text-white rounded-xl font-bold hover:from-rose-400 hover:to-fuchsia-500 transition-colors glow-pink">
              Thêm Tài Liệu Đầu Tiên
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" style={{ padding: '16px 0' }}>
            {documents
              .slice()
              .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
              .flatMap(docData => docData.chapters.map(ch => ({ ...ch, _doc: docData, _docCreatedAt: docData.createdAt || 0 })))
              .map((chapter) => {
                const docData = chapter._doc;
                const chapterQs = questions.filter(q => q.chapterId === chapter.id);
                const wrongCount = chapterQs.filter(q => userStats.wrongQs?.includes(q.id)).length;
                const segments = chapter.segments || [];
                const exploitedCount = segments.filter(s => s.exploitedAt).length;
                const totalSegments = segments.length;
                const allExploited = totalSegments > 0 && exploitedCount === totalSegments;
                const remainingSegments = totalSegments - exploitedCount;
                const chapterJobStatus = genQueue.find(j => j.chapterId === chapter.id && (j.status === 'processing' || j.status === 'pending'));

                return (
                  <div key={chapter.id}
                    className={`relative bg-white dark:bg-white/5 rounded-xl flex flex-col gap-1.5 transition-all ${chapterJobStatus?.status === 'processing' ? 'ring-2 ring-fuchsia-400/60 animate-pulse' : chapterJobStatus?.status === 'pending' ? 'ring-1 ring-amber-400/40' : 'hover:border-[rgba(212,83,126,0.4)]'}`}
                    style={{ border: '0.5px solid rgba(212,83,126,0.2)', padding: '14px 16px' }}>
                    <button
                      onClick={() => handleDeleteChapter(chapter, docData)}
                      className="absolute flex items-center justify-center rounded-md text-[#C4B5C0] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      style={{ top: 8, right: 8, width: 22, height: 22 }}
                      title="Xóa bài này">
                      <XCircle className="w-3.5 h-3.5" />
                    </button>

                    <h4 className="font-semibold text-sm text-[#2C2C2A] dark:text-white pr-8" style={{ lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {chapter.title}
                    </h4>

                    <div className="flex items-center gap-2 text-xs text-[#888780] dark:text-gray-400 font-medium">
                      <span>{chapterQs.length} câu</span>
                      {wrongCount > 0 && <span className="text-red-400">· {wrongCount} sai</span>}
                      {totalSegments > 0 && <span>{exploitedCount}/{totalSegments} đoạn</span>}
                      {allExploited && <span className="text-emerald-400 font-bold">✅</span>}
                      {chapterJobStatus && (
                        <span className="text-fuchsia-400 flex items-center gap-1">
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          {chapterJobStatus.status === 'processing' ? 'Đang tạo...' : 'Đang chờ...'}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 mt-2">
                      <button
                        onClick={() => setQuizSetupModal({ isOpen: true, chapter, chapterQs })}
                        disabled={chapterQs.length === 0}
                        className="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold rounded-lg disabled:opacity-50 transition-colors"
                        style={{ padding: '7px 10px', background: 'rgba(212,83,126,0.08)', color: '#993556', border: '1px solid rgba(212,83,126,0.3)' }}>
                        <Play className="w-3.5 h-3.5" /> Tu Luyện
                      </button>
                      {allExploited ? (
                        <button onClick={() => handleAdvancedQuestions(chapter, docData)}
                          className="flex items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
                          style={{ width: 30, height: 30, fontSize: 14 }} title="Nâng Cao Bloom L4-L6">
                          <TrendingUp className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <>
                          <button onClick={() => openDifficultySetup(chapter, docData, 'single')}
                            className="flex items-center justify-center rounded-lg border border-rose-200/40 dark:border-white/10 hover:bg-rose-50 dark:hover:bg-white/5 transition-colors text-gray-400"
                            style={{ width: 30, height: 30, fontSize: 14 }} title="Tạo câu hỏi (1 đoạn)">
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                          {(remainingSegments > 1 || totalSegments === 0) && (
                            <button onClick={() => openDifficultySetup(chapter, docData, 'all')}
                              className="flex items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
                              style={{ width: 30, height: 30, fontSize: 14 }} title="Khai thác toàn bộ các đoạn">
                              <Layers className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </>
                      )}
                      <button onClick={() => handleGenerateSummary(chapter)}
                        className="flex items-center justify-center rounded-lg bg-fuchsia-500/10 text-fuchsia-400 border border-fuchsia-500/20 hover:bg-fuchsia-500/20 transition-colors"
                        style={{ width: 30, height: 30, fontSize: 14 }} title="Tóm tắt AI">
                        <Sparkles className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        )}

        {/* Difficulty Setup Modal */}
        {difficultySetupModal.isOpen && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[110] flex items-center justify-center p-4 animate-fade-in">
            <div className="glass-card border border-fuchsia-500/30 rounded-3xl p-8 max-w-md w-full shadow-2xl animate-scale-in">
              <h2 className="text-2xl font-black text-gray-900 dark:text-white mb-1 text-center flex items-center justify-center gap-2">
                <BrainCircuit className="w-6 h-6 text-fuchsia-400" /> Chỉnh Độ Khó Câu Hỏi
              </h2>
              <p className="text-center text-gray-400 mb-6 text-sm">
                {difficultySetupModal.mode === 'all'
                  ? `Áp dụng cho TẤT CẢ đoạn chưa khai thác · mỗi đoạn sẽ tạo số câu bên dưới`
                  : 'Tùy chỉnh số lượng câu dễ / trung bình / khó cho mỗi lần tạo'}
              </p>

              <div className="space-y-5 mb-6">
                {/* Easy */}
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="font-bold text-emerald-400 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block"></span> Dễ (Easy)
                    </label>
                    <span className="font-black text-xl text-emerald-400 w-8 text-center">{difficultyDist.easy}</span>
                  </div>
                  <input type="range" min="0" max="15" value={difficultyDist.easy}
                    onChange={e => setDifficultyDist(prev => ({ ...prev, easy: Number(e.target.value) }))}
                    className="w-full accent-emerald-400 h-2 rounded-full" />
                  <p className="text-xs text-gray-500 mt-1">Nhớ/Remember: Định nghĩa, liệt kê, nhận diện</p>
                </div>

                {/* Medium */}
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="font-bold text-amber-400 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-amber-400 inline-block"></span> Trung Bình (Medium)
                    </label>
                    <span className="font-black text-xl text-amber-400 w-8 text-center">{difficultyDist.medium}</span>
                  </div>
                  <input type="range" min="0" max="15" value={difficultyDist.medium}
                    onChange={e => setDifficultyDist(prev => ({ ...prev, medium: Number(e.target.value) }))}
                    className="w-full accent-amber-400 h-2 rounded-full" />
                  <p className="text-xs text-gray-500 mt-1">Hiểu/Understand: Giải thích, so sánh, tóm tắt</p>
                </div>

                {/* Hard */}
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="font-bold text-rose-400 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-rose-400 inline-block"></span> Khó (Hard)
                    </label>
                    <span className="font-black text-xl text-rose-400 w-8 text-center">{difficultyDist.hard}</span>
                  </div>
                  <input type="range" min="0" max="15" value={difficultyDist.hard}
                    onChange={e => setDifficultyDist(prev => ({ ...prev, hard: Number(e.target.value) }))}
                    className="w-full accent-rose-400 h-2 rounded-full" />
                  <p className="text-xs text-gray-500 mt-1">Vận dụng/Phân tích: Tình huống thực tế, đánh giá</p>
                </div>
              </div>

              {/* Summary */}
              <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-6 flex items-center justify-between">
                <span className="text-gray-400 text-sm">Tổng số câu sẽ tạo:</span>
                <span className="font-black text-xl text-white">
                  {difficultyDist.easy + difficultyDist.medium + difficultyDist.hard} câu
                  <span className="text-xs font-normal text-gray-400 ml-2">
                    ({difficultyDist.easy} dễ · {difficultyDist.medium} TB · {difficultyDist.hard} khó)
                  </span>
                </span>
              </div>

              {(difficultyDist.easy + difficultyDist.medium + difficultyDist.hard) === 0 && (
                <p className="text-red-400 text-sm text-center mb-4">⚠️ Vui lòng chọn ít nhất 1 câu</p>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setDifficultySetupModal({ isOpen: false, chapter: null, docData: null, mode: 'single' })}
                  className="flex-1 py-3 rounded-xl font-bold text-gray-400 hover:text-white border border-white/10 hover:border-white/30 transition-all">
                  Hủy
                </button>
                <button
                  disabled={(difficultyDist.easy + difficultyDist.medium + difficultyDist.hard) === 0}
                  onClick={() => {
                    const { chapter, docData, mode } = difficultySetupModal;
                    setDifficultySetupModal({ isOpen: false, chapter: null, docData: null, mode: 'single' });
                    enqueueGeneration(chapter, docData, difficultyDist, mode || 'single');
                  }}
                  className="flex-1 py-3 rounded-xl font-black bg-gradient-to-r from-fuchsia-600 to-rose-600 hover:from-fuchsia-500 hover:to-rose-500 text-white shadow-lg transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                  <Sparkles className="w-4 h-4" /> {difficultySetupModal.mode === 'all' ? 'Tạo Toàn Bộ' : 'Tạo Câu Hỏi'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Quiz Setup Modal */}
        {quizSetupModal.isOpen && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-fade-in">
            <div className="glass-card border border-rose-500/30 rounded-3xl p-8 max-w-md w-full shadow-2xl glow-pink animate-scale-in">
              <h2 className="text-2xl font-black text-gray-900 dark:text-white mb-2 text-center">Lựa Chọn Hình Thức Bế Quan</h2>
              <p className="text-center text-gray-400 mb-6 text-sm">{quizSetupModal.chapter.title}</p>
              <div className="space-y-4">
                <button onClick={() => startQuiz('standard', quizSetupModal.chapter.id, quizSetupModal.chapterQs)} className="w-full bg-gradient-to-r from-rose-600 to-fuchsia-600 hover:from-rose-500 hover:to-fuchsia-500 text-gray-900 dark:text-white py-4 rounded-xl font-bold flex flex-col items-center shadow-lg transition-transform hover:-translate-y-1">
                  <span className="text-lg">Tiểu Chu Thiên</span>
                  <span className="text-xs font-normal opacity-80">Ôn ngẫu nhiên {settings.defaultCount} câu</span>
                </button>
                <button onClick={() => startQuiz('all', quizSetupModal.chapter.id, quizSetupModal.chapterQs)} className="w-full bg-gradient-to-r from-fuchsia-600 to-purple-600 hover:from-fuchsia-500 hover:to-purple-500 text-gray-900 dark:text-white py-4 rounded-xl font-bold flex flex-col items-center shadow-lg transition-transform hover:-translate-y-1">
                  <span className="text-lg">Đại Chu Thiên</span>
                  <span className="text-xs font-normal opacity-80">Tu luyện toàn vẹn {quizSetupModal.chapterQs.length} câu</span>
                </button>
                {(() => {
                  const wrongCount = quizSetupModal.chapterQs.filter(q => userStats.wrongQs?.includes(q.id)).length;
                  return (
                    <button onClick={() => startQuiz('review', quizSetupModal.chapter.id, quizSetupModal.chapterQs)} disabled={wrongCount === 0}
                      className={`w-full py-4 rounded-xl font-bold flex flex-col items-center transition-all ${wrongCount > 0 ? 'bg-red-600 hover:bg-red-500 text-gray-900 dark:text-white shadow-lg hover:-translate-y-1' : 'bg-rose-50 dark:bg-white/5 text-gray-500 cursor-not-allowed border border-rose-200/40 dark:border-white/10'}`}>
                      <span className="text-lg flex items-center gap-2"><Target className="w-5 h-5" /> Trảm Tâm Ma</span>
                      <span className="text-xs font-normal opacity-80">{wrongCount > 0 ? `Ôn lại ${wrongCount} câu đã sai` : 'Không có câu nào sai'}</span>
                    </button>
                  );
                })()}
              </div>
              <button onClick={() => setQuizSetupModal({ isOpen: false, chapter: null, chapterQs: [] })} className="mt-6 w-full text-gray-500 hover:text-gray-900 dark:text-white font-medium py-2 transition-colors">Hủy Bỏ</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ——— QUIZ SCREEN ———
  const renderQuiz = () => {
    if (!activeSession) return null;
    const { questions: sessionQs, currentIndex, userAnswers, isChecking } = activeSession;
    const currentQ = sessionQs[currentIndex];
    const currentSelected = userAnswers[currentQ.id] || [];

    const handleSelectOption = (key) => {
      if (isChecking) return;
      const newSelected = currentQ.type === 'multiple'
        ? (currentSelected.includes(key) ? currentSelected.filter(k => k !== key) : [...currentSelected, key])
        : [key];
      setActiveSession({ ...activeSession, userAnswers: { ...userAnswers, [currentQ.id]: newSelected } });
    };

    const handleCheckAnswer = () => {
      const isCorrect = currentQ.correctAnswers.length === currentSelected.length
        && currentQ.correctAnswers.every(k => currentSelected.includes(k));
      const xpReward = isCorrect ? XP_REWARDS[currentQ.difficulty] : 0;
      setActiveSession({
        ...activeSession, isChecking: true,
        score: activeSession.score + (isCorrect ? 1 : 0),
        xpGained: activeSession.xpGained + xpReward,
        wrongInSession: !isCorrect ? [...activeSession.wrongInSession, currentQ.id] : activeSession.wrongInSession,
        correctInSession: isCorrect ? [...activeSession.correctInSession, currentQ.id] : activeSession.correctInSession,
      });
    };

    const handleNext = async () => {
      if (currentIndex < sessionQs.length - 1) {
        setActiveSession({ ...activeSession, currentIndex: currentIndex + 1, isChecking: false });
        setMnemonicState({ isLoading: false, text: '' });
      } else {
        const result = { ...activeSession, date: new Date().toLocaleString() };
        let updatedWrongQs = [...(userStats.wrongQs || [])];
        result.wrongInSession.forEach(id => { if (!updatedWrongQs.includes(id)) updatedWrongQs.push(id); });
        result.correctInSession.forEach(id => { updatedWrongQs = updatedWrongQs.filter(wId => wId !== id); });
        const sDoc = doc(db, statsDoc(user.uid));
        const newHistory = [result, ...(userStats.history || [])].slice(0, 20);
        await updateDoc(sDoc, { xp: userStats.xp + activeSession.xpGained, history: newHistory, wrongQs: updatedWrongQs });
        setSessionResult(result);
        setActiveSession(null);
        setCurrentScreen('result');
      }
    };

    return (
      <div className="max-w-4xl mx-auto flex flex-col gap-[10px] p-[16px] animate-fade-in">
        {/* Quiz Header */}
        <div className="flex items-center justify-between mb-[8px] glass-card p-3 rounded-2xl border border-rose-200/30 dark:border-white/5">
          <div className="flex items-center gap-4">
            <button onClick={() => { if (window.confirm('Thoát giữa chừng?')) { setActiveSession(null); setCurrentScreen('dashboard'); } }}
              className="text-gray-400 hover:text-red-400 p-2"><XCircle className="w-6 h-6" /></button>
            <div className="h-8 w-px bg-rose-100/50 dark:bg-white/10"></div>
            <p className="font-bold text-gray-900 dark:text-white">Thí Luyện {currentIndex + 1} / {sessionQs.length}</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })} className="p-2 text-gray-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-white/5 rounded-full transition-colors" title="Đổi giao diện">
              {settings.theme === 'dark' ? <Moon className="w-5 h-5 text-indigo-300" /> : <Sun className="w-5 h-5 text-amber-500" />}
            </button>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="h-2 w-full bg-rose-100/50 dark:bg-white/10 rounded-full mb-[12px] overflow-hidden">
          <div className="h-full bg-gradient-to-r from-rose-500 to-fuchsia-500 transition-all progress-shimmer" style={{ width: `${((currentIndex) / sessionQs.length) * 100}%` }}></div>
        </div>

        <div className="w-full">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase mb-[8px] inline-block border
            ${currentQ.difficulty === 'easy' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
            : currentQ.difficulty === 'medium' ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
            : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
            {currentQ.difficulty === 'easy' ? '🟢 Dễ' : currentQ.difficulty === 'medium' ? '🟡 Trung bình' : '🔴 Khó'}
          </span>
          {currentQ.type === 'multiple' && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 uppercase mb-[8px] inline-block ml-2">Nhiều đáp án</span>
          )}
          {currentQ.bloomLevel && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-fuchsia-500/10 border border-fuchsia-500/20 text-fuchsia-400 uppercase mb-[8px] inline-block ml-2">Bloom L{currentQ.bloomLevel}</span>
          )}
          <h2 className="text-[18px] font-semibold text-[#1A1A1A] dark:text-white mb-[12px] leading-snug">{currentQ.question}</h2>

          <div className="space-y-[6px] mb-0">
            {currentQ.options.map((opt, index) => (
              <div key={opt.key} id={`quiz-opt-${opt.key}`} onClick={() => handleSelectOption(opt.key)}
                className={`py-[10px] px-[14px] rounded-xl border-2 cursor-pointer transition-all flex items-center gap-3 relative overflow-hidden group ${
                  !isChecking
                    ? (currentSelected.includes(opt.key)
                      ? 'border-rose-500 bg-rose-500/10 text-[#2C2C2A] dark:text-white'
                      : 'border-rose-200/40 dark:border-white/10 text-[#2C2C2A] dark:text-gray-200 hover:border-rose-500/30 hover:bg-rose-50 dark:bg-white/5')
                    : (currentQ.correctAnswers.includes(opt.key)
                      ? 'border-[#16A34A] bg-[#16A34A]/10 text-[#14532D] dark:text-emerald-300'
                      : currentSelected.includes(opt.key)
                        ? 'border-[#E53E3E] bg-[#E53E3E]/10 text-[#7B1D1D] dark:text-red-300'
                        : 'opacity-40 text-[#2C2C2A] dark:text-white border-rose-200/40 dark:border-white/10')
                }`}>
                <div className={`w-[24px] h-[24px] rounded-md flex items-center justify-center font-bold text-[12px] flex-shrink-0 transition-colors ${
                  !isChecking 
                    ? (currentSelected.includes(opt.key) ? 'bg-rose-500 text-white' : 'bg-rose-200/60 dark:bg-white/10 text-[#2C2C2A]')
                    : (currentQ.correctAnswers.includes(opt.key)
                        ? 'bg-[#16A34A] text-white'
                        : currentSelected.includes(opt.key) ? 'bg-[#E53E3E] text-white' : 'bg-rose-200/60 dark:bg-white/10 text-[#2C2C2A]')
                }`}>{opt.key}</div>
                <span className="text-[14px] font-medium leading-snug">{opt.text}</span>
                {isChecking && currentQ.correctAnswers.includes(opt.key) && <CheckCircle2 className="w-[18px] h-[18px] text-[#16A34A] ml-auto flex-shrink-0" />}
                {isChecking && !currentQ.correctAnswers.includes(opt.key) && currentSelected.includes(opt.key) && <XCircle className="w-[18px] h-[18px] text-[#E53E3E] ml-auto flex-shrink-0" />}
              </div>
            ))}
          </div>

          {isChecking && (
            <div className="space-y-2">
              <div className="bg-rose-500/10 border border-rose-500/20 py-[12px] px-[14px] mt-[10px] rounded-xl animate-fade-in-up">
                <h4 className="font-semibold text-[13px] text-[#92400E] dark:text-rose-300 mb-1 flex items-center gap-1.5"><Info className="w-4 h-4" /> Chân Lý Giải Thích</h4>
                <p className="text-[#78350F] dark:text-rose-200/80 text-[12px] leading-[1.5]">{currentQ.explanation}</p>
                {currentQ.citation?.text && (
                  <div className="mt-[8px] py-[8px] px-[12px] bg-rose-50 dark:bg-white/5 rounded-r-lg italic text-[12px] text-[#44403C] dark:text-gray-400 border-l-[3px] border-[#D97706]">
                    "{currentQ.citation.text}"
                  </div>
                )}
              </div>
              
              {mnemonicState.text && (
                <div className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 rounded-xl p-4 animate-fade-in">
                  <h4 className="font-bold text-[13px] text-[#92400E] dark:text-amber-300 mb-1 flex gap-1.5"><Sparkles className="w-4 h-4" /> Bí Quyết Ghi Nhớ:</h4>
                  <p className="text-[#78350F] dark:text-amber-100 text-[12px] leading-[1.5] font-medium">{mnemonicState.text}</p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-[12px] w-full static">
          <div className="flex flex-row items-center justify-center gap-2">
            {isChecking && !mnemonicState.text && (
              <button onClick={() => handleGenerateMnemonic(currentQ)} disabled={mnemonicState.isLoading}
                className="w-[40%] text-[#92400E] font-semibold bg-[#FEF3C7] border-[1.5px] border-[#D97706] rounded-[12px] text-[14px] py-[14px] flex justify-center items-center gap-1.5 transition-all hover:bg-[#FDE68A]">
                {mnemonicState.isLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <><Sparkles className="w-4 h-4" /> Xin Mẹo</>}
              </button>
            )}
            
            {!isChecking ? (
              <button id="quiz-check-btn" onClick={handleCheckAnswer} disabled={currentSelected.length === 0}
                className="w-full bg-[#16A34A] text-[white] py-[14px] rounded-[12px] font-semibold text-[16px] disabled:opacity-50 hover:bg-[#15803D] transition-all relative overflow-hidden">
                <span className="relative z-10">Khẳng Định Đáp Án (Enter)</span>
              </button>
            ) : (
              <button id="quiz-next-btn" onClick={handleNext}
                className={`bg-[#16A34A] text-white py-[14px] rounded-[12px] font-semibold text-[16px] flex items-center justify-center gap-1.5 hover:bg-[#15803D] transition-all relative overflow-hidden ${!mnemonicState.text ? 'w-[60%]' : 'w-full'}`}>
                <span className="relative z-10 flex items-center gap-1.5">{currentIndex < sessionQs.length - 1 ? 'Tiếp tục Thí Luyện' : 'Hoàn thành Cảnh Giới'} (Enter) <ArrowRight className="w-4 h-4" /></span>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ==========================================
  // 🖥 MAIN RENDER
  // ==========================================
  if (authLoading) {
    return (
      <div className="min-h-screen mesh-gradient flex flex-col items-center justify-center">
        <RefreshCw className="w-12 h-12 animate-spin text-rose-500 mb-4" />
        <p className="text-xl font-black tracking-widest text-rose-400 animate-pulse">KẾT NỐI TIÊN GIỚI...</p>
      </div>
    );
  }

  if (!user) return renderLogin();

  return (
    <div className="min-h-screen bg-[var(--bg-page)] transition-colors duration-300">
      {/* Onboarding */}
      {showOnboarding && renderOnboarding()}

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-[100] animate-fade-in-down">
          <div className={`flex items-center gap-3 px-6 py-4 rounded-xl shadow-2xl border glass-card ${toast.type === 'error' ? 'border-red-500/30 text-red-400' : 'border-emerald-500/30 text-emerald-400'}`}>
            {toast.type === 'error' ? <AlertCircle className="w-6 h-6 text-red-500" /> : <CheckCircle2 className="w-6 h-6 text-emerald-500" />}
            <span className="font-medium">{toast.msg}</span>
          </div>
        </div>
      )}

      {/* TRIBULATION MODAL */}
      {tribulationModal.isOpen && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4">
          {tribulationModal.isStriking && <div className="fixed inset-0 z-[201] pointer-events-none animate-flash bg-white/20"></div>}
          <div className={`relative z-[202] border-4 rounded-3xl p-8 max-w-lg w-full text-center shadow-2xl transition-all duration-300
            ${tribulationModal.isStriking ? 'animate-shake border-white bg-gray-100 shadow-[0_0_150px_rgba(255,255,255,0.8)]'
              : tribulationModal.result === 'fail' ? 'border-red-500 bg-red-950/50'
              : tribulationModal.result === 'success' ? 'border-emerald-500 bg-emerald-950/50'
              : 'border-amber-500 bg-gray-900 glow-amber'}`}>
            {tribulationModal.isStriking && (
              <div className="absolute inset-0 flex justify-center items-center pointer-events-none overflow-hidden rounded-3xl z-[-1]">
                <Zap className="w-64 h-64 text-amber-300 animate-strike drop-shadow-[0_0_30px_rgba(255,255,255,1)]" />
              </div>
            )}
            {tribulationModal.result === null ? (
              <div className={`transition-opacity ${tribulationModal.isStriking ? 'opacity-20' : 'opacity-100 animate-fade-in-up'}`}>
                <Zap className="w-20 h-20 text-amber-500 mx-auto mb-4 animate-bounce" />
                <h2 className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-300 to-amber-600 mb-2 tracking-widest uppercase">Độ Kiếp</h2>
                <p className="text-gray-300 text-lg mb-8">Tu vi đã đạt đỉnh phong! Phi thăng lên <strong className="text-gray-900 dark:text-white text-xl block mt-2">{tribulationModal.targetLevel?.name}</strong></p>
                <div className="bg-black/60 rounded-2xl p-5 mb-8 text-left border border-gray-700">
                  <div className="flex justify-between items-center mb-3"><span className="text-gray-400">Tỉ lệ thành công:</span><span className="text-emerald-400 font-bold text-xl">{(tribulationModal.successRate * 100).toFixed(0)}%</span></div>
                  <div className="flex justify-between items-center mb-4"><span className="text-gray-400">Tâm ma phản phệ:</span><span className="text-red-400 font-bold text-xl">{((1 - tribulationModal.successRate) * 100).toFixed(0)}%</span></div>
                  {userStats.failBonus > 0 && <div className="bg-emerald-900/30 text-emerald-400 p-2 rounded text-sm text-center mb-3 border border-emerald-800/50">Đạo tâm kiên định: +{(userStats.failBonus * 100).toFixed(0)}% từ lần trước</div>}
                  <div className="bg-red-900/30 text-red-300 p-3 rounded-lg text-xs leading-relaxed flex items-start gap-2 border border-red-800/50"><ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" /> Thất bại sẽ mất 50% tu vi, nhưng tăng +5% lần sau.</div>
                </div>
                <button onClick={handleDoKiep} disabled={tribulationModal.isStriking}
                  className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-gray-900 dark:text-white font-black text-xl py-5 rounded-xl transition-all transform hover:scale-105 glow-amber disabled:opacity-50 disabled:scale-100">
                  {tribulationModal.isStriking ? 'ĐANG CHỊU LÔI KIẾP...' : 'NGHÊNH ĐÓN THIÊN KIẾP'}
                </button>
                {!tribulationModal.isStriking && <button onClick={() => setTribulationModal({ isOpen: false })} className="mt-4 text-gray-500 hover:text-gray-900 dark:text-white text-sm font-medium">Tạm thời bế quan thêm (Hủy)</button>}
              </div>
            ) : tribulationModal.result === 'success' ? (
              <div className="animate-fade-in-up">
                <Cloud className="w-24 h-24 text-cyan-400 mx-auto mb-4 animate-pulse" />
                <h2 className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 to-cyan-400 mb-4">ĐỘT PHÁ THÀNH CÔNG!</h2>
                <p className="text-gray-300 text-lg mb-8">Đạo hữu đã bước vào <strong className="text-gray-900 dark:text-white text-2xl block mt-2">{tribulationModal.targetLevel?.name}</strong></p>
                <button onClick={() => setTribulationModal({ isOpen: false })} className="w-full bg-gradient-to-r from-emerald-500 to-cyan-500 text-gray-900 dark:text-white font-bold py-4 rounded-xl">Củng cố tu vi</button>
              </div>
            ) : (
              <div className="animate-fade-in-up">
                <ShieldAlert className="w-24 h-24 text-red-500 mx-auto mb-4 animate-pulse" />
                <h2 className="text-4xl font-black text-red-500 mb-4">ĐỘ KIẾP THẤT BẠI</h2>
                <p className="text-red-200 text-lg mb-6">Mất <strong className="text-red-400 text-2xl block mt-2">{tribulationModal.penaltyXp} Tu vi</strong></p>
                <p className="text-amber-400 text-sm mb-8 font-medium">Lần sau +5% thành công.</p>
                <button onClick={() => setTribulationModal({ isOpen: false })} className="w-full bg-red-900 hover:bg-red-800 border border-red-500 text-gray-900 dark:text-white font-bold py-4 rounded-xl">Bế quan chữa thương</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* SUMMARY MODAL */}
      {summaryModal.isOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fade-in">
          <div className="glass-card border border-fuchsia-500/30 rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-scale-in">
            <div className="px-6 py-5 border-b border-rose-200/30 dark:border-white/5 flex justify-between items-center bg-fuchsia-500/10">
              <h2 className="text-xl font-bold flex items-center gap-2 text-fuchsia-300"><Sparkles className="w-5 h-5" /> {summaryModal.title}</h2>
              <button onClick={() => setSummaryModal({ isOpen: false, isLoading: false, title: '', content: '' })} className="text-gray-400 hover:text-gray-900 dark:text-white p-2 rounded-full"><XCircle className="w-5 h-5" /></button>
            </div>
            <div className="p-8 overflow-y-auto flex-1 custom-scrollbar">
              {summaryModal.isLoading ? (
                <div className="flex flex-col items-center justify-center py-20 text-fuchsia-400">
                  <div className="relative flex items-center justify-center w-24 h-24 mb-6">
                    <div className="absolute inset-0 border-4 border-transparent border-t-rose-500 border-b-fuchsia-500 rounded-full magic-spin-1"></div>
                    <div className="absolute inset-2 border-4 border-transparent border-l-amber-400 border-r-rose-400 rounded-full magic-spin-2"></div>
                    <div className="absolute inset-4 border-2 border-transparent border-t-fuchsia-400 border-b-amber-400 border-dashed rounded-full magic-spin-3"></div>
                    <BrainCircuit className="w-8 h-8 text-rose-400 relative z-10 animate-pulse" />
                    <div className="absolute inset-0 bg-rose-500/10 blur-xl rounded-full"></div>
                  </div>
                  <p className="font-medium animate-pulse text-lg">Khí linh đang diễn hoá văn tự...</p>
                </div>
              ) : (
                <div className="prose dark:prose-invert max-w-none">
                  <p className="whitespace-pre-wrap leading-relaxed text-gray-300 text-lg">{summaryModal.content}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {renderHeader()}

      <main>
        {currentScreen === 'dashboard' && renderDashboard()}

        {currentScreen === 'upload' && (
          <div className="max-w-3xl mx-auto px-4 py-8 animate-fade-in">
            <button onClick={() => setCurrentScreen('dashboard')} className="flex items-center gap-2 text-gray-400 hover:text-rose-400 font-medium mb-8 transition-colors">
              <ArrowRight className="w-4 h-4 rotate-180" /> Trở về Tàng Kinh Các
            </button>
            <div className="glass-card p-8 md:p-10 rounded-3xl shadow-2xl border border-rose-200/30 dark:border-white/5">
              <h2 className="text-3xl font-black text-gray-900 dark:text-white mb-2 flex items-center gap-3"><Cloud className="text-rose-400 w-8 h-8" /> Khắc Ghi Ngọc Giản</h2>
              <p className="text-gray-400 mb-8">Dán tâm pháp vào đây, Khí linh sẽ tự phân tích và chia thành các đoạn ngữ nghĩa.</p>
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-bold text-gray-300 mb-2">Tên Tâm Pháp</label>
                  <input type="text" value={uploadTitle} onChange={e => setUploadTitle(e.target.value)} placeholder="Ví dụ: Luyện Khí Kỳ - Tập 1..."
                    className="w-full px-5 py-4 rounded-xl border border-rose-200/40 dark:border-white/10 bg-rose-50 dark:bg-white/5 text-gray-900 dark:text-white placeholder-gray-600 focus:ring-2 focus:ring-rose-500 outline-none transition-all" />
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-300 mb-2">Nội dung (Pháp Ngữ)</label>
                  <textarea value={uploadText} onChange={e => setUploadText(e.target.value)} placeholder="Dán nội dung sách vào đây..."
                    className="w-full h-80 px-5 py-4 rounded-xl border border-rose-200/40 dark:border-white/10 bg-rose-50 dark:bg-white/5 text-gray-900 dark:text-white placeholder-gray-600 focus:ring-2 focus:ring-rose-500 outline-none resize-none font-mono text-sm leading-relaxed custom-scrollbar" />
                </div>
                <button onClick={() => saveDocToCloud(uploadTitle, uploadText)} disabled={!uploadText.trim() || isLoading}
                  className="w-full py-5 bg-gradient-to-r from-rose-500 to-fuchsia-600 text-gray-900 dark:text-white rounded-xl font-black text-lg hover:shadow-lg disabled:opacity-50 transition-all flex items-center justify-center gap-2 transform hover:-translate-y-1 glow-pink">
                  {isLoading ? <RefreshCw className="w-6 h-6 animate-spin" /> : <><Cloud className="w-6 h-6" /> Lưu Chép Lên Thiên Các</>}
                </button>
              </div>
            </div>
          </div>
        )}

        {currentScreen === 'quiz' && renderQuiz()}

        {currentScreen === 'result' && sessionResult && !tribulationModal.isOpen && (
          <div className="max-w-3xl mx-auto px-4 py-16 text-center animate-fade-in">
            <div className="glass-card p-10 md:p-14 rounded-3xl shadow-2xl border border-rose-200/30 dark:border-white/5 relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-b from-rose-500/10 to-transparent pointer-events-none"></div>
              <Trophy className="w-20 h-20 text-amber-400 mx-auto mb-6 relative z-10" />
              <h2 className="text-4xl font-black text-gray-900 dark:text-white mb-2 relative z-10">Bế Quan Hoàn Tất!</h2>
              <p className="text-gray-400 text-lg mb-10 relative z-10">Đạo tâm kiên định, tu vi tăng trưởng.</p>
              <div className="grid grid-cols-2 gap-6 mb-12 text-center relative z-10">
                <div className="glass-card border border-rose-200/40 dark:border-white/10 p-6 rounded-2xl">
                  <p className="text-gray-400 font-bold uppercase tracking-wider mb-2 text-sm">Kết Quả</p>
                  <p className="text-4xl font-black text-rose-400">{sessionResult.score}<span className="text-2xl text-gray-600">/{sessionResult.questions.length}</span></p>
                </div>
                <div className="bg-amber-500/10 border border-amber-500/20 p-6 rounded-2xl">
                  <p className="text-amber-400 font-bold uppercase tracking-wider mb-2 text-sm">Tu Vi Thu Được</p>
                  <p className="text-4xl font-black text-amber-400">+{sessionResult.xpGained} <Star className="inline-block w-6 h-6 -mt-2" /></p>
                </div>
              </div>
              {sessionResult.wrongInSession?.length > 0 && (
                <div className="mb-8 relative z-10">
                  <button onClick={() => {
                    const wrongQsData = sessionResult.questions.filter(q => sessionResult.wrongInSession.includes(q.id));
                    startQuiz('review_session', sessionResult.chapterId, wrongQsData);
                  }} className="w-full bg-red-600 hover:bg-red-500 text-gray-900 dark:text-white py-4 rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg transition-transform hover:-translate-y-1">
                    <Target className="w-5 h-5" /> Trảm Tâm Ma ({sessionResult.wrongInSession.length} câu)
                  </button>
                </div>
              )}
              {userStats.xp >= getXpReq(userStats.level) && !getLevelInfo(userStats.level).isMax && (
                <div className="bg-amber-500/10 text-amber-400 p-4 rounded-xl mb-8 font-bold animate-pulse border border-amber-500/20">
                  <Zap className="inline-block w-5 h-5 mr-2 -mt-1" /> Tu vi đã đầy! Trở về để Độ Kiếp!
                </div>
              )}
              <button onClick={() => setCurrentScreen('dashboard')}
                className="w-full md:w-auto px-12 py-5 bg-gradient-to-r from-rose-500 to-fuchsia-600 text-gray-900 dark:text-white rounded-xl font-bold text-lg hover:shadow-xl transition-all relative z-10 glow-pink">
                Trở về Tàng Kinh Các
              </button>
            </div>
          </div>
        )}

        {currentScreen === 'settings' && (
          <div className="max-w-lg mx-auto px-4 py-8 animate-fade-in">
            <div className="glass-card p-8 rounded-3xl border border-rose-200/30 dark:border-white/5 shadow-2xl">
              <h2 className="text-2xl font-black text-gray-900 dark:text-white mb-8 flex items-center gap-3"><Settings className="text-rose-400" /> Trận Pháp Cài Đặt</h2>
              {user && (
                <div className="flex items-center gap-4 p-4 bg-rose-50 dark:bg-white/5 rounded-2xl mb-8 border border-rose-200/30 dark:border-white/5">
                  {user.photoURL && <img src={user.photoURL} referrerPolicy="no-referrer" alt="avatar" className="w-12 h-12 rounded-full border-2 border-rose-400" />}
                  <div><p className="font-bold text-gray-900 dark:text-white">{user.displayName}</p><p className="text-sm text-gray-500">{user.email}</p></div>
                </div>
              )}
              <div className="space-y-8">
                <div>
                  <label className="block text-sm font-bold text-gray-300 mb-3">Nhà Cung Cấp AI</label>
                  <select value={settings.provider || 'gemini'} onChange={e => updateSettings({ provider: e.target.value })}
                    className="w-full px-5 py-3 border border-rose-200/40 dark:border-white/10 bg-rose-50 dark:bg-white/5 rounded-xl text-gray-900 dark:text-white focus:ring-2 focus:ring-rose-500 outline-none cursor-pointer">
                    <option value="gemini">Gemini (Google)</option>
                    <option value="openai-compat">OpenAI Compatible (Beeknoee, OpenRouter, v.v.)</option>
                  </select>
                </div>
                <div className="h-px bg-rose-100/50 dark:bg-white/10"></div>

                {(settings.provider || 'gemini') === 'gemini' ? (
                  <>
                    <div>
                      <label className="block text-sm font-bold text-gray-300 mb-3">Gemini API Key</label>
                      <input type="password" value={settings.apiKey} onChange={e => updateSettings({ apiKey: e.target.value })}
                        className="w-full px-5 py-3 border border-rose-200/40 dark:border-white/10 bg-rose-50 dark:bg-white/5 rounded-xl text-gray-900 dark:text-white focus:ring-2 focus:ring-rose-500 outline-none transition-all" placeholder="Nhập API Key..." />
                      <p className="text-xs text-gray-500 mt-1">Lấy key miễn phí tại aistudio.google.com/apikey</p>
                    </div>
                    <div className="h-px bg-rose-100/50 dark:bg-white/10"></div>
                    <div>
                      <label className="block text-sm font-bold text-gray-300 mb-3">Model AI</label>
                      <select value={settings.model || 'gemini-2.5-flash'} onChange={e => updateSettings({ model: e.target.value })}
                        className="w-full px-5 py-3 border border-rose-200/40 dark:border-white/10 bg-rose-50 dark:bg-white/5 rounded-xl text-gray-900 dark:text-white focus:ring-2 focus:ring-rose-500 outline-none cursor-pointer">
                        <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                      </select>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-sm font-bold text-gray-300 mb-3">Base URL</label>
                      <input type="text" value={settings.customBaseUrl || ''} onChange={e => updateSettings({ customBaseUrl: e.target.value })}
                        className="w-full px-5 py-3 border border-rose-200/40 dark:border-white/10 bg-rose-50 dark:bg-white/5 rounded-xl text-gray-900 dark:text-white focus:ring-2 focus:ring-rose-500 outline-none transition-all" placeholder="https://api.example.com/v1" />
                      <p className="text-xs text-gray-500 mt-1">VD: https://platform.beeknoee.com/api/v1</p>
                    </div>
                    <div>
                      <label className="block text-sm font-bold text-gray-300 mb-3">API Key</label>
                      <input type="password" value={settings.apiKey} onChange={e => updateSettings({ apiKey: e.target.value })}
                        className="w-full px-5 py-3 border border-rose-200/40 dark:border-white/10 bg-rose-50 dark:bg-white/5 rounded-xl text-gray-900 dark:text-white focus:ring-2 focus:ring-rose-500 outline-none transition-all" placeholder="sk-..." />
                    </div>
                    <div>
                      <label className="block text-sm font-bold text-gray-300 mb-3">Model ID</label>
                      <input type="text" value={settings.customModelId || ''} onChange={e => updateSettings({ customModelId: e.target.value })}
                        className="w-full px-5 py-3 border border-rose-200/40 dark:border-white/10 bg-rose-50 dark:bg-white/5 rounded-xl text-gray-900 dark:text-white focus:ring-2 focus:ring-rose-500 outline-none transition-all" placeholder="Tên model (VD: gpt-4o, deepseek-chat...)" />
                      <p className="text-xs text-gray-500 mt-1">Nhập tên model do nhà cung cấp hỗ trợ</p>
                    </div>
                  </>
                )}
                <div className="h-px bg-rose-100/50 dark:bg-white/10"></div>
                <div>
                  <label className="block text-sm font-bold text-gray-300 mb-3">Ngôn Ngữ Đầu Ra (AI)</label>
                  <select value={settings.quizLanguage || 'auto'} onChange={e => updateSettings({ quizLanguage: e.target.value })}
                    className="w-full px-5 py-3 border border-rose-200/40 dark:border-white/10 bg-rose-50 dark:bg-white/5 rounded-xl text-gray-900 dark:text-white focus:ring-2 focus:ring-rose-500 outline-none cursor-pointer">
                    <option value="auto">Tự động (Dựa trên văn bản gốc)</option>
                    <option value="vi">Ép buộc Tiếng Việt 🇻🇳</option>
                    <option value="en">Ép buộc Tiếng Anh 🇺🇸</option>
                  </select>
                </div>
                <div className="h-px bg-rose-100/50 dark:bg-white/10"></div>
                <div>
                  <p className="block text-sm font-bold text-gray-300 mb-3">Bảo Lưu Nguyên Thần</p>
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={handleExportData} className="flex items-center justify-center gap-2 py-3 bg-rose-50 dark:bg-white/5 text-gray-300 rounded-xl hover:bg-rose-100/50 dark:bg-white/10 transition-all font-medium border border-rose-200/40 dark:border-white/10">
                      <Download className="w-5 h-5" /> Xuất
                    </button>
                    <label className="flex items-center justify-center gap-2 py-3 bg-rose-500/10 text-rose-400 rounded-xl hover:bg-rose-500/20 transition-all font-medium cursor-pointer border border-rose-500/20">
                      <UploadCloud className="w-5 h-5" /> Nhập
                      <input type="file" className="hidden" accept=".json" onChange={handleImportData} />
                    </label>
                  </div>
                </div>
                <div className="h-px bg-rose-100/50 dark:bg-white/10"></div>
                <div>
                  <label className="block text-sm font-bold text-gray-300 mb-3">Số câu Tiểu Chu Thiên</label>
                  <select value={settings.defaultCount} onChange={e => updateSettings({ defaultCount: parseInt(e.target.value) })}
                    className="w-full px-5 py-3 border border-rose-200/40 dark:border-white/10 bg-rose-50 dark:bg-white/5 rounded-xl text-gray-900 dark:text-white focus:ring-2 focus:ring-rose-500 outline-none cursor-pointer">
                    <option value={5}>5 câu (Sơ nhập)</option>
                    <option value={10}>10 câu (Khổ tu)</option>
                    <option value={20}>20 câu (Sinh tử quan)</option>
                  </select>
                </div>
                <button onClick={() => setCurrentScreen('dashboard')}
                  className="w-full bg-gradient-to-r from-rose-500 to-fuchsia-600 text-gray-900 dark:text-white py-4 rounded-xl font-bold text-lg transition-all glow-pink">
                  Lưu Lại Trận Pháp
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* QUEUE PROGRESS WIDGET */}
      {genQueue.length > 0 && (() => {
        const doneJobs = genQueue.filter(j => j.status === 'done');
        const errorJobs = genQueue.filter(j => j.status === 'error');
        const cancelledJobs = genQueue.filter(j => j.status === 'cancelled');
        const pendingJobs = genQueue.filter(j => j.status === 'pending');
        const processingJob = genQueue.find(j => j.status === 'processing');
        const totalJobs = genQueue.length;
        const finishedCount = doneJobs.length + errorJobs.length + cancelledJobs.length;
        const totalQsCreated = doneJobs.reduce((sum, j) => sum + (j.result?.questionsCreated || 0), 0);
        const allDone = !processingJob && pendingJobs.length === 0;

        return (
          <div className="fixed z-[100] animate-fade-in" style={{ bottom: 20, right: 20, width: 340 }}>
            <div className="glass-card rounded-2xl border border-fuchsia-500/30 shadow-2xl overflow-hidden">
              <div
                className="flex items-center justify-between px-4 py-3 cursor-pointer select-none"
                style={{ background: allDone ? 'rgba(16,185,129,0.1)' : 'rgba(212,83,126,0.08)' }}
                onClick={() => setQueueWidgetCollapsed(prev => !prev)}>
                <div className="flex items-center gap-2">
                  {allDone
                    ? <CheckCircle2 className={`w-4 h-4 ${cancelledJobs.length > 0 && errorJobs.length === 0 ? 'text-orange-400' : 'text-emerald-400'}`} />
                    : <RefreshCw className="w-4 h-4 text-fuchsia-400 animate-spin" />}
                  <span className="text-sm font-bold text-gray-900 dark:text-white">
                    {allDone
                      ? (cancelledJobs.length > 0 && doneJobs.length === 0 ? 'Đã dừng'
                        : `${cancelledJobs.length > 0 ? 'Đã dừng · ' : 'Hoàn tất! '}${totalQsCreated} câu đã tạo`)
                      : 'Đang tạo câu hỏi...'}
                  </span>
                </div>
                <ChevronRight className={`w-4 h-4 text-gray-400 transition-transform ${queueWidgetCollapsed ? '' : 'rotate-90'}`} />
              </div>

              {!queueWidgetCollapsed && (
                <div className="px-4 pb-3">
                  <div className="h-1.5 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden mt-1 mb-2">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${allDone ? 'bg-emerald-500' : 'bg-gradient-to-r from-rose-500 to-fuchsia-500'}`}
                      style={{ width: `${totalJobs > 0 ? (finishedCount / totalJobs) * 100 : 0}%` }} />
                  </div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-gray-500 dark:text-gray-400">{finishedCount}/{totalJobs} hoàn thành · {totalQsCreated} câu đã tạo</p>
                    {!allDone && (
                      <button onClick={(e) => {
                        e.stopPropagation();
                        setGenQueue(prev => prev.map(j =>
                          j.status === 'pending' ? { ...j, status: 'cancelled' }
                          : j.status === 'processing' ? { ...j, status: 'cancelled' }
                          : j
                        ));
                        processingRef.current = false;
                      }} className="text-xs px-2.5 py-1 rounded-lg bg-orange-500/20 text-orange-300 hover:bg-orange-500/30 font-medium transition-colors flex items-center gap-1">
                        <Square className="w-3 h-3" /> Dừng
                      </button>
                    )}
                  </div>

                  {processingJob && (
                    <div className="flex items-center gap-2 text-xs text-fuchsia-400 font-medium mb-1">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span className="truncate">{processingJob.segmentTitle || processingJob.chapterTitle}</span>
                    </div>
                  )}

                  {pendingJobs.length > 0 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5 max-h-24 overflow-y-auto custom-scrollbar">
                      {pendingJobs.slice(0, 5).map(j => (
                        <div key={j.id} className="flex items-center gap-1.5">
                          <Clock className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{j.segmentTitle || j.chapterTitle}</span>
                        </div>
                      ))}
                      {pendingJobs.length > 5 && <p className="text-gray-600">...và {pendingJobs.length - 5} đoạn khác</p>}
                    </div>
                  )}

                  {errorJobs.length > 0 && (
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs text-red-400">{errorJobs.length} lỗi</span>
                      {allDone && (
                        <button onClick={(e) => {
                          e.stopPropagation();
                          setGenQueue(prev => prev.map(j => j.status === 'error' ? { ...j, status: 'pending', error: null } : j));
                        }} className="text-xs px-2.5 py-1 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30 font-medium transition-colors">
                          Thử lại
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* GLOBAL LOADING */}
      {isLoading && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[150] flex flex-col items-center justify-center text-gray-900 dark:text-white">
          <div className="relative flex items-center justify-center w-32 h-32">
            {/* Outer Ring */}
            <div className="absolute inset-0 border-4 border-transparent border-t-rose-500 border-b-fuchsia-500 rounded-full magic-spin-1"></div>
            {/* Middle Ring */}
            <div className="absolute inset-3 border-4 border-transparent border-r-amber-400 border-l-rose-400 rounded-full magic-spin-2"></div>
            {/* Inner Ring */}
            <div className="absolute inset-6 border-4 border-transparent border-t-fuchsia-400 border-b-amber-400 border-dashed rounded-full magic-spin-3"></div>
            
            {/* Center Core */}
            <BrainCircuit className="w-10 h-10 text-rose-300 relative z-10 animate-pulse" />
            
            {/* Glow Effect */}
            <div className="absolute inset-0 bg-gradient-to-tr from-rose-500/20 to-fuchsia-500/20 blur-2xl rounded-full"></div>
          </div>
          <p className="text-2xl font-black mt-6 tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-rose-300 to-fuchsia-300 animate-pulse">{loadingMsg}</p>
        </div>
      )}
    </div>
  );
}
