import React, { useState, useEffect, useRef } from 'react';
import {
  UploadCloud, BookOpen, BrainCircuit, Trophy, Settings,
  CheckCircle2, XCircle, Flame, Star,
  Play, Plus, Clock, FileText, ArrowRight, RefreshCw,
  AlertCircle, Info, Sparkles, Download, Cloud, Zap, ShieldAlert, Target,
  LogIn, LogOut, User
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
// 🔊 SOUND EFFECTS (Web Audio API fallback)
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
  } catch (e) { /* silent fail if no audio support */ }
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

const parseChapters = (text) => {
  const regex = /(?=(?:^|\n)(?:Chương|Chapter|PHẦN|Bài)\s+[0-9IVX]+)/i;
  const parts = text.split(regex).filter(p => p.trim().length > 0);
  if (parts.length === 1 && !parts[0].match(/^(?:Chương|Chapter|PHẦN|Bài)/i)) {
    return [{ id: generateId(), title: "Nội dung chung", content: text.trim() }];
  }
  return parts.map((content, i) => {
    const titleMatch = content.match(/^(?:Chương|Chapter|PHẦN|Bài)\s+[0-9IVX]+[^\n]*/i);
    const title = titleMatch ? titleMatch[0].trim() : `Chương ${i + 1}`;
    return { id: generateId(), title, content: content.trim() };
  });
};

// Firestore path helpers (per-user private data)
const userPath = (uid) => `users/${uid}`;
const docsCol  = (uid) => `users/${uid}/documents`;
const questionsCol = (uid) => `users/${uid}/questions`;
const statsDoc = (uid) => `users/${uid}/stats/profile`;
const settingsDocPath = (uid) => `users/${uid}/settings/user`;

// ==========================================
// 🤖 GEMINI API
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

const generateTextWithGemini = async (prompt, apiKey) => {
  const model = apiKey ? 'gemini-1.5-flash' : 'gemini-2.0-flash';
  const key = apiKey || '';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7 }
    })
  });
  if (!res.ok) throw new Error("Lỗi khi gọi Khí Linh (AI). Kiểm tra API Key hoặc thử lại sau.");
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
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
    apiKey: '', theme: 'dark', defaultCount: 10, timerEnabled: true
  });

  // Transient UI
  const [activeSession, setActiveSession] = useState(null);
  const [sessionResult, setSessionResult] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [toast, setToast] = useState(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadText, setUploadText] = useState('');

  // AI States
  const [summaryModal, setSummaryModal] = useState({ isOpen: false, isLoading: false, title: '', content: '' });
  const [mnemonicState, setMnemonicState] = useState({ isLoading: false, text: '' });
  const [tribulationModal, setTribulationModal] = useState({
    isOpen: false, targetLevel: null, successRate: 1,
    result: null, penaltyXp: 0, isStriking: false
  });
  const [quizSetupModal, setQuizSetupModal] = useState({ isOpen: false, chapter: null, chapterQs: [] });

  // Timer
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerRef = useRef(null);

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
      if (snap.exists()) setSettings(snap.data());
    });

    return () => { unsubStats(); unsubDocs(); unsubQ(); unsubSettings(); };
  }, [user]);

  // Apply theme
  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
  }, [settings.theme]);

  // Quiz timer
  useEffect(() => {
    if (activeSession && settings.timerEnabled) {
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [activeSession?.startTime, settings.timerEnabled]);

  const showToast = (msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // ——— DATA OPERATIONS ———
  const saveDocToCloud = async (title, text) => {
    if (!user) return;
    setIsLoading(true); setLoadingMsg("Đang khắc ghi Ngọc Giản...");
    try {
      const chapters = parseChapters(text);
      const docRef = doc(collection(db, docsCol(user.uid)));
      await setDoc(docRef, { title: title || "Tâm Pháp Mới", chapters, createdAt: Date.now() });
      setUploadTitle(''); setUploadText('');
      setCurrentScreen('dashboard');
      showToast("Ghi chép Ngọc Giản thành công!", "success");
    } catch (err) {
      showToast("Lỗi: " + err.message, "error");
    } finally { setIsLoading(false); }
  };

  const handleDeleteDoc = async (docData) => {
    if (!user || !window.confirm('Hủy bỏ ngọc giản này? Toàn bộ câu hỏi cũng sẽ bị xóa.')) return;
    try {
      // Delete all questions for this doc's chapters in batch
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

  const handleGenerateQuestions = async (chapter) => {
    if (!user) return;
    setIsLoading(true);
    setLoadingMsg(`Khí Linh đang diễn hoá câu hỏi cho "${chapter.title}"...`);
    try {
      const existingText = questions
        .filter(q => q.chapterId === chapter.id)
        .map(q => q.question).join("\n");
      const prompt = `
[STRICT LANGUAGE INSTRUCTION]
You MUST auto-detect the language of the "NỘI DUNG TÀI LIỆU" below.
You MUST output all questions, options, explanations, and citations in the EXACT SAME LANGUAGE as the provided text.
DO NOT translate to Vietnamese if the source is not Vietnamese.

Role: Educational Expert.
Task: Generate 10 high-quality multiple choice questions based on the provided chapter content.

NỘI DUNG TÀI LIỆU:
---
${chapter.content.substring(0, 15000)}
---

EXISTING QUESTIONS (DO NOT DUPLICATE):
${existingText || "None"}

REQUIREMENTS:
1. 3 Easy, 4 Medium, 3 Hard questions.
2. Both "single" and "multiple" answer types.
3. Detailed explanations.

RETURN FORMAT:
MUST return a RAW JSON array with exact structure:
[
  {
    "id": "random_id",
    "question": "Question text?",
    "type": "single",
    "difficulty": "easy",
    "options": [
      { "key": "A", "text": "Option 1" },
      { "key": "B", "text": "Option 2" },
      { "key": "C", "text": "Option 3" },
      { "key": "D", "text": "Option 4" }
    ],
    "correctAnswers": ["A"],
    "explanation": "Detailed explanation...",
    "citation": { "text": "Quote from text", "chapter": "${chapter.title}" },
    "tags": ["keyword1"]
  }
]`;

      const rawRes = await generateTextWithGemini(prompt, settings.apiKey);
      const jsonMatch = rawRes.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("Khí linh tẩu hỏa nhập ma, định dạng trả về sai.");
      const newQsRaw = JSON.parse(jsonMatch[0]);

      const batch = writeBatch(db);
      for (const qData of newQsRaw) {
        const qRef = doc(collection(db, questionsCol(user.uid)));
        batch.set(qRef, { ...qData, chapterId: chapter.id, id: qRef.id });
      }
      await batch.commit();
      showToast(`Đã tạo ${newQsRaw.length} câu hỏi mới!`, "success");
    } catch (err) {
      showToast("Lỗi: " + err.message, "error");
    } finally { setIsLoading(false); }
  };

  const handleGenerateSummary = async (chapter) => {
    setSummaryModal({ isOpen: true, isLoading: true, title: chapter.title, content: '' });
    try {
      const prompt = `
[STRICT LANGUAGE INSTRUCTION]
You MUST generate the summary in the EXACT SAME LANGUAGE as the source text below. Do NOT translate.
Role: AI Tutor. Summarize the key points using bullet points and bold keywords.
Chapter Content:\n${chapter.content.substring(0, 15000)}`;
      const text = await generateTextWithGemini(prompt, settings.apiKey);
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
      const prompt = `
[STRICT LANGUAGE INSTRUCTION]
Generate the mnemonic in the EXACT SAME LANGUAGE as the question below.
Question: "${currentQ.question}"
Correct Answer: "${correctText}"
Explanation: "${currentQ.explanation}"
Task: Create a memorable MNEMONIC (acronym, funny mental image, or rhyme). Keep it short and direct.`;
      const text = await generateTextWithGemini(prompt, settings.apiKey);
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
    a.href = url;
    a.download = `TuTienLo_Backup_${new Date().getTime()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Đã xuất toàn bộ dữ liệu!", "success");
  };

  const handleImportData = (e) => {
    const file = e.target.files[0];
    if (!file || !user) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        setIsLoading(true);
        setLoadingMsg("Đang dung hợp Nguyên Thần và Bí Kíp...");
        const imported = JSON.parse(evt.target.result);
        if (!imported.documents || !imported.questions) throw new Error("Định dạng file không đúng.");

        const batch = writeBatch(db);
        imported.documents.forEach(d =>
          batch.set(doc(db, docsCol(user.uid), d.id), d)
        );
        imported.questions.forEach(q =>
          batch.set(doc(db, questionsCol(user.uid), q.id), q)
        );
        await batch.commit();

        if (imported.userStats) {
          await setDoc(doc(db, statsDoc(user.uid)), imported.userStats, { merge: true });
        }
        showToast("Dung hợp thành công! Khôi phục toàn bộ tu vi.", "success");
      } catch (err) {
        showToast("Lỗi khi nhập dữ liệu: " + err.message, "error");
      } finally {
        setIsLoading(false);
        e.target.value = null;
      }
    };
    reader.readAsText(file);
  };

  // ——— QUIZ SETUP ———
  const startQuiz = (mode, chapterId, chapterQs) => {
    let selectedQs = [];
    const shuffled = [...chapterQs].sort(() => 0.5 - Math.random());
    if (mode === 'standard') selectedQs = shuffled.slice(0, settings.defaultCount);
    else if (mode === 'all') selectedQs = shuffled;
    else if (mode === 'review') selectedQs = shuffled.filter(q => userStats.wrongQs?.includes(q.id));
    else if (mode === 'review_session') selectedQs = shuffled;

    setActiveSession({
      chapterId,
      questions: selectedQs,
      currentIndex: 0,
      userAnswers: {},
      isChecking: false,
      score: 0,
      startTime: Date.now(),
      xpGained: 0,
      wrongInSession: [],
      correctInSession: []
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
      isOpen: true,
      targetLevel: getLevelInfo(userStats.level + 1),
      successRate: actualRate,
      result: null,
      penaltyXp: 0,
      isStriking: false
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
        await updateDoc(sDoc, {
          level: userStats.level + 1,
          xp: Math.max(0, userStats.xp - xpReq),
          failBonus: 0,
        });
        setTribulationModal(prev => ({ ...prev, result: 'success', isStriking: false }));
      } else {
        playSound('fail');
        const penaltyXp = Math.floor(userStats.xp * 0.5);
        await updateDoc(sDoc, {
          xp: userStats.xp - penaltyXp,
          failBonus: userStats.failBonus + 0.05,
        });
        setTribulationModal(prev => ({ ...prev, result: 'fail', penaltyXp, isStriking: false }));
      }
    }, 2000);
  };

  const updateSettings = async (newSettings) => {
    if (!user) return;
    const merged = { ...settings, ...newSettings };
    await setDoc(doc(db, settingsDocPath(user.uid)), merged, { merge: true });
  };

  // ==========================================
  // 🖥 UI RENDERERS
  // ==========================================

  // ——— LOGIN SCREEN ———
  const renderLogin = () => (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 p-4">
      <div className="max-w-md w-full text-center">
        <div className="bg-gray-800 border border-gray-700 rounded-3xl p-10 shadow-2xl">
          <div className="bg-gradient-to-br from-indigo-500 to-yellow-500 p-4 rounded-2xl border border-yellow-300/50 inline-block mb-6">
            <Zap className="w-12 h-12 text-white" />
          </div>
          <h1 className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-yellow-400 mb-3 uppercase tracking-wider">
            Tu Tiên Lộ
          </h1>
          <p className="text-gray-400 mb-10 leading-relaxed">
            Hệ thống ôn thi thông minh theo phong cách tu tiên.<br />
            Đăng nhập để bắt đầu hành trình tu luyện của bạn.
          </p>
          <button
            onClick={handleGoogleSignIn}
            className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-100 text-gray-800 font-bold py-4 rounded-xl text-lg transition-all transform hover:-translate-y-1 shadow-lg"
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

  // ——— HEADER ———
  const renderHeader = () => (
    <header className="bg-white dark:bg-gray-800 shadow-sm sticky top-0 z-10 transition-colors border-b border-gray-200 dark:border-gray-700/50">
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setCurrentScreen('dashboard')}>
          <div className="bg-gradient-to-br from-indigo-500 to-yellow-500 p-2 rounded-xl border border-yellow-300/50">
            <Zap className="w-6 h-6 text-white" />
          </div>
          <span className="font-bold text-xl bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-yellow-600 dark:from-indigo-400 dark:to-yellow-400 uppercase tracking-wider">
            Tu Tiên Lộ
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden md:flex items-center gap-3 bg-gray-50 dark:bg-gray-700/50 px-4 py-1.5 rounded-full border border-gray-100 dark:border-gray-600 text-sm">
            <span className="flex items-center gap-1.5 text-orange-500 font-medium"><Flame className="w-4 h-4" /> {userStats.streak}</span>
            <div className="w-px h-4 bg-gray-300 dark:bg-gray-500"></div>
            <span className="flex items-center gap-1.5 text-yellow-500 dark:text-yellow-400 font-medium"><Star className="w-4 h-4" /> {userStats.xp}</span>
          </div>
          {user?.photoURL && (
            <img src={user.photoURL} referrerPolicy="no-referrer" alt="avatar" className="w-8 h-8 rounded-full border-2 border-indigo-400" />
          )}
          <button onClick={() => setCurrentScreen('upload')} className="p-2 text-gray-500 hover:text-indigo-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"><Plus className="w-5 h-5" /></button>
          <button onClick={() => setCurrentScreen('settings')} className="p-2 text-gray-500 hover:text-indigo-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"><Settings className="w-5 h-5" /></button>
          <button onClick={handleSignOut} className="p-2 text-gray-500 hover:text-red-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors" title="Xuất quan"><LogOut className="w-5 h-5" /></button>
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
        {/* Cultivation Card */}
        <div className={`rounded-3xl p-6 md:p-8 text-white shadow-[0_0_30px_rgba(79,70,229,0.3)] mb-8 relative overflow-hidden border transition-all duration-500
          ${isReadyForBreakthrough
            ? 'bg-gradient-to-r from-yellow-600 to-orange-600 border-yellow-400 shadow-[0_0_40px_rgba(234,179,8,0.5)]'
            : lvlInfo.isMax
              ? 'bg-gradient-to-r from-blue-900 to-purple-900 border-cyan-400 shadow-[0_0_40px_rgba(6,182,212,0.5)]'
              : 'bg-gradient-to-r from-gray-800 to-indigo-900 border-indigo-500/30'}`}>
          <div className="absolute right-0 top-0 opacity-10 w-64 h-64 transform translate-x-16 -translate-y-16">
            {lvlInfo.isMax ? <Cloud className="w-full h-full text-cyan-300" /> : <Zap className="w-full h-full text-yellow-500" />}
          </div>
          <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-6 w-full md:w-auto">
              <div className={`w-24 h-24 bg-black/40 rounded-full border-2 flex items-center justify-center backdrop-blur-sm text-4xl shadow-[0_0_20px_rgba(250,204,21,0.4)]
                ${isReadyForBreakthrough ? 'border-white animate-pulse' : 'border-yellow-400'}`}>
                {lvlInfo.name.split(" ")[0]}
              </div>
              <div className="flex-1">
                <p className="text-indigo-200 font-medium mb-1 tracking-widest uppercase text-xs">Cảnh Giới Hiện Tại</p>
                <h1 className="text-3xl md:text-4xl font-black mb-2 text-transparent bg-clip-text bg-gradient-to-r from-yellow-200 to-yellow-500 drop-shadow-md">
                  {lvlInfo.name.substring(2)}
                </h1>
                <p className="text-sm text-indigo-100 flex items-center gap-1">
                  {user?.displayName && <span className="opacity-70">{user.displayName} · </span>}
                  Bế quan liên tục {userStats.streak} ngày 🔥
                </p>
              </div>
            </div>

            <div className="w-full md:w-1/3 flex flex-col justify-center">
              {!isReadyForBreakthrough && !lvlInfo.isMax ? (
                <>
                  <div className="flex justify-between text-sm mb-2 font-bold text-yellow-300">
                    <span>Tu vi: {userStats.xp}</span><span>{xpReq}</span>
                  </div>
                  <div className="h-4 bg-black/50 rounded-full overflow-hidden border border-indigo-500/50">
                    <div className="h-full bg-gradient-to-r from-indigo-500 to-yellow-400 transition-all duration-1000 relative" style={{ width: `${progressPercent}%` }}>
                      <div className="absolute top-0 right-0 bottom-0 w-2 bg-white/50 blur-[2px]"></div>
                    </div>
                  </div>
                  <p className="text-right text-xs mt-2 text-indigo-200">Còn {xpReq - userStats.xp} tu vi nữa</p>
                </>
              ) : isReadyForBreakthrough ? (
                <div className="text-center animate-fade-in-up">
                  <p className="text-yellow-100 mb-3 font-medium">Bình cảnh đã xuất hiện!</p>
                  <button onClick={handleOpenTribulation} className="w-full bg-gradient-to-r from-yellow-400 to-yellow-300 hover:from-yellow-300 hover:to-yellow-200 text-yellow-900 font-black py-4 rounded-xl shadow-lg transform hover:-translate-y-1 transition-all flex items-center justify-center gap-2">
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
            { label: "Tâm Ma (Câu sai)", val: userStats.wrongQs.length, icon: Target, color: "text-red-500", bg: "bg-red-100 dark:bg-red-900/30" },
            { label: "Đạo tâm (Tỉ lệ đúng)", val: `${accuracy}%`, icon: Trophy, color: "text-orange-500", bg: "bg-orange-100 dark:bg-orange-900/30" },
            { label: "Tổng Tu Vi", val: userStats.xp, icon: Star, color: "text-purple-500", bg: "bg-purple-100 dark:bg-purple-900/30" },
            { label: "Ngộ Đạo Bonus", val: `+${(userStats.failBonus * 100).toFixed(0)}%`, icon: BrainCircuit, color: "text-green-500", bg: "bg-green-100 dark:bg-green-900/30" }
          ].map((stat, i) => (
            <div key={i} className="bg-white dark:bg-gray-800 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 flex items-center gap-4 hover:border-indigo-300 transition-colors">
              <div className={`p-3 rounded-xl ${stat.bg} ${stat.color}`}><stat.icon className="w-6 h-6" /></div>
              <div><p className="text-sm text-gray-500 dark:text-gray-400">{stat.label}</p><p className="text-xl font-bold text-gray-900 dark:text-white">{stat.val}</p></div>
            </div>
          ))}
        </div>

        {/* Documents */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><BookOpen className="text-indigo-500" /> Tàng Kinh Các</h2>
          <button onClick={() => setCurrentScreen('upload')} className="flex items-center gap-2 text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-gray-800 px-4 py-2 rounded-lg transition-colors"><Plus className="w-4 h-4" /> Khắc Ngọc Giản</button>
        </div>

        {documents.length === 0 ? (
          <div className="text-center py-16 bg-white dark:bg-gray-800/50 rounded-3xl border border-dashed border-gray-300 dark:border-gray-700">
            <Cloud className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
            <h3 className="text-xl font-medium dark:text-white mb-2">Tàng Kinh Các đang trống</h3>
            <p className="text-gray-500 mb-6">Hãy dán tâm pháp (tài liệu) để Khí Linh diễn hóa thành bài khảo nghiệm.</p>
            <button onClick={() => setCurrentScreen('upload')} className="px-8 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-500 transition-colors">
              Thêm Tài Liệu Đầu Tiên
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {documents.map(docData => (
              <div key={docData.id} className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
                <div className="bg-gray-50 dark:bg-gray-800/80 px-6 py-4 flex justify-between items-center border-b dark:border-gray-700">
                  <h3 className="font-bold text-lg dark:text-white flex items-center gap-2"><FileText className="w-5 h-5 text-indigo-500" /> {docData.title}</h3>
                  <button onClick={() => handleDeleteDoc(docData)} className="text-gray-400 hover:text-red-500 p-2 transition-colors"><XCircle className="w-5 h-5" /></button>
                </div>
                <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {docData.chapters.map(chapter => {
                    const chapterQs = questions.filter(q => q.chapterId === chapter.id);
                    const wrongCount = chapterQs.filter(q => userStats.wrongQs?.includes(q.id)).length;
                    return (
                      <div key={chapter.id} className="border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 rounded-xl p-5 flex flex-col justify-between hover:border-indigo-500/50 hover:shadow-md transition-all">
                        <div>
                          <h4 className="font-semibold text-gray-900 dark:text-white mb-2 line-clamp-2">{chapter.title}</h4>
                          <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400 mb-4">
                            <span className="flex items-center gap-1"><BrainCircuit className="w-4 h-4 text-indigo-400" /> {chapterQs.length} câu</span>
                            {wrongCount > 0 && <span className="flex items-center gap-1 text-red-500"><Target className="w-4 h-4" /> {wrongCount} tâm ma</span>}
                          </div>
                        </div>
                        <div className="flex gap-2 mt-auto">
                          <button
                            onClick={() => setQuizSetupModal({ isOpen: true, chapter, chapterQs })}
                            disabled={chapterQs.length === 0}
                            className="flex-1 py-2 rounded-lg font-bold text-sm bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 disabled:opacity-50 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors flex items-center justify-center gap-2">
                            <Play className="w-4 h-4" /> Tu Luyện
                          </button>
                          <button onClick={() => handleGenerateSummary(chapter)} className="px-3 py-2 bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400 border border-purple-200 dark:border-purple-800 rounded-lg hover:bg-purple-100 dark:hover:bg-purple-900/60 transition-colors" title="Tóm tắt AI"><Sparkles className="w-4 h-4" /></button>
                          <button onClick={() => handleGenerateQuestions(chapter)} className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-gray-600 dark:text-gray-300" title="Tạo thêm câu hỏi"><RefreshCw className="w-4 h-4" /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Quiz Setup Modal */}
        {quizSetupModal.isOpen && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-fade-in">
            <div className="bg-white dark:bg-gray-800 border-2 border-indigo-500/50 rounded-3xl p-8 max-w-md w-full shadow-[0_0_30px_rgba(79,70,229,0.3)]">
              <h2 className="text-2xl font-black text-gray-900 dark:text-white mb-2 text-center">Lựa Chọn Hình Thức Bế Quan</h2>
              <p className="text-center text-gray-500 dark:text-gray-400 mb-6 text-sm">{quizSetupModal.chapter.title}</p>
              <div className="space-y-4">
                <button onClick={() => startQuiz('standard', quizSetupModal.chapter.id, quizSetupModal.chapterQs)} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-4 rounded-xl font-bold flex flex-col items-center shadow-lg transition-transform hover:-translate-y-1">
                  <span className="text-lg">Tiểu Chu Thiên</span>
                  <span className="text-xs font-normal opacity-80">Ôn ngẫu nhiên {settings.defaultCount} câu</span>
                </button>
                <button onClick={() => startQuiz('all', quizSetupModal.chapter.id, quizSetupModal.chapterQs)} className="w-full bg-purple-600 hover:bg-purple-500 text-white py-4 rounded-xl font-bold flex flex-col items-center shadow-lg transition-transform hover:-translate-y-1">
                  <span className="text-lg">Đại Chu Thiên</span>
                  <span className="text-xs font-normal opacity-80">Tu luyện toàn vẹn {quizSetupModal.chapterQs.length} câu</span>
                </button>
                {(() => {
                  const wrongCount = quizSetupModal.chapterQs.filter(q => userStats.wrongQs?.includes(q.id)).length;
                  return (
                    <button
                      onClick={() => startQuiz('review', quizSetupModal.chapter.id, quizSetupModal.chapterQs)}
                      disabled={wrongCount === 0}
                      className={`w-full py-4 rounded-xl font-bold flex flex-col items-center transition-all ${wrongCount > 0 ? 'bg-red-600 hover:bg-red-500 text-white shadow-lg hover:-translate-y-1' : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'}`}>
                      <span className="text-lg flex items-center gap-2"><Target className="w-5 h-5" /> Trảm Tâm Ma</span>
                      <span className="text-xs font-normal opacity-80">{wrongCount > 0 ? `Ôn lại ${wrongCount} câu đã sai` : 'Không có câu nào sai ở đây'}</span>
                    </button>
                  );
                })()}
              </div>
              <button onClick={() => setQuizSetupModal({ isOpen: false, chapter: null, chapterQs: [] })} className="mt-6 w-full text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white font-medium py-2">Hủy Bỏ</button>
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
        ...activeSession,
        isChecking: true,
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
        const timeSpent = elapsedSeconds;
        const result = { ...activeSession, timeSpent, date: new Date().toLocaleString() };

        let updatedWrongQs = [...(userStats.wrongQs || [])];
        result.wrongInSession.forEach(id => { if (!updatedWrongQs.includes(id)) updatedWrongQs.push(id); });
        result.correctInSession.forEach(id => { updatedWrongQs = updatedWrongQs.filter(wId => wId !== id); });

        const sDoc = doc(db, statsDoc(user.uid));
        const newHistory = [result, ...(userStats.history || [])].slice(0, 20);
        await updateDoc(sDoc, {
          xp: userStats.xp + activeSession.xpGained,
          history: newHistory,
          wrongQs: updatedWrongQs
        });

        setSessionResult(result);
        setCurrentScreen('result');
      }
    };

    return (
      <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in min-h-screen flex flex-col">
        {/* Quiz Header */}
        <div className="flex items-center justify-between mb-8 bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-4">
            <button onClick={() => { if (window.confirm('Thoát giữa chừng? Tu vi lần này sẽ không được lưu.')) setCurrentScreen('dashboard'); }}
              className="text-gray-400 hover:text-red-500 p-2"><XCircle className="w-6 h-6" /></button>
            <div className="h-8 w-px bg-gray-200 dark:bg-gray-700"></div>
            <p className="font-bold text-gray-900 dark:text-white">Thí Luyện {currentIndex + 1} / {sessionQs.length}</p>
          </div>
          {settings.timerEnabled && (
            <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-4 py-2 rounded-lg font-mono font-bold">
              <Clock className="w-4 h-4" /> {String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:{String(elapsedSeconds % 60).padStart(2, '0')}
            </div>
          )}
        </div>

        {/* Progress Bar */}
        <div className="h-2 w-full bg-gray-200 dark:bg-gray-700 rounded-full mb-8 overflow-hidden">
          <div className="h-full bg-gradient-to-r from-indigo-500 to-yellow-500 transition-all" style={{ width: `${((currentIndex) / sessionQs.length) * 100}%` }}></div>
        </div>

        <div className="flex-1">
          <span className={`text-xs font-bold px-3 py-1 rounded-full uppercase mb-4 inline-block
            ${currentQ.difficulty === 'easy' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
            : currentQ.difficulty === 'medium' ? 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300'
            : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'}`}>
            {currentQ.difficulty === 'easy' ? '🟢 Dễ' : currentQ.difficulty === 'medium' ? '🟡 Trung bình' : '🔴 Khó'}
          </span>
          {currentQ.type === 'multiple' && (
            <span className="text-xs font-bold px-3 py-1 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 uppercase mb-4 inline-block ml-2">
              Nhiều đáp án
            </span>
          )}
          <h2 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white mb-8 leading-relaxed">{currentQ.question}</h2>

          <div className="space-y-4 mb-8">
            {currentQ.options.map((opt) => (
              <div key={opt.key} onClick={() => handleSelectOption(opt.key)}
                className={`p-5 rounded-2xl border-2 cursor-pointer transition-all flex items-center gap-4 ${
                  !isChecking
                    ? (currentSelected.includes(opt.key)
                      ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30'
                      : 'border-gray-200 dark:border-gray-700 dark:text-white hover:border-indigo-300 hover:bg-gray-50 dark:hover:bg-gray-800/60')
                    : (currentQ.correctAnswers.includes(opt.key)
                      ? 'border-green-500 bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                      : currentSelected.includes(opt.key)
                        ? 'border-red-500 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                        : 'opacity-50 dark:text-white border-gray-200 dark:border-gray-700')
                }`}>
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold flex-shrink-0 transition-colors ${
                  currentSelected.includes(opt.key) ? 'bg-indigo-500 text-white' : 'bg-gray-100 dark:bg-gray-700 dark:text-gray-300'
                }`}>{opt.key}</div>
                <span className="text-lg font-medium">{opt.text}</span>
                {isChecking && currentQ.correctAnswers.includes(opt.key) && <CheckCircle2 className="w-5 h-5 text-green-500 ml-auto flex-shrink-0" />}
                {isChecking && !currentQ.correctAnswers.includes(opt.key) && currentSelected.includes(opt.key) && <XCircle className="w-5 h-5 text-red-500 ml-auto flex-shrink-0" />}
              </div>
            ))}
          </div>

          {isChecking && (
            <div className="space-y-4">
              <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800 p-6 rounded-2xl animate-fade-in-up">
                <h4 className="font-bold text-indigo-900 dark:text-indigo-200 mb-2 flex items-center gap-2"><Info className="w-5 h-5" /> Chân Lý Giải Thích</h4>
                <p className="text-indigo-800 dark:text-indigo-300 leading-relaxed">{currentQ.explanation}</p>
                {currentQ.citation?.text && (
                  <div className="mt-4 p-4 bg-white/60 dark:bg-black/20 rounded-xl italic text-sm text-gray-600 dark:text-gray-400 border-l-4 border-indigo-300">
                    "{currentQ.citation.text}"
                  </div>
                )}
              </div>
              {!mnemonicState.text && !mnemonicState.isLoading && (
                <button onClick={() => handleGenerateMnemonic(currentQ)}
                  className="w-full flex justify-center gap-2 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-100 dark:hover:bg-yellow-900/40 py-4 rounded-xl border border-yellow-200 dark:border-yellow-800/50 font-bold transition-colors">
                  <Sparkles className="w-5 h-5" /> Xin Mẹo Ghi Nhớ Từ Khí Linh
                </button>
              )}
              {mnemonicState.isLoading && (
                <div className="flex justify-center gap-2 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 py-4 rounded-xl border border-yellow-200 dark:border-yellow-800/50 font-bold">
                  <RefreshCw className="w-5 h-5 animate-spin" /> Khí linh đang ngộ đạo...
                </div>
              )}
              {mnemonicState.text && (
                <div className="bg-gradient-to-r from-yellow-50 to-orange-50 dark:from-yellow-900/30 dark:to-orange-900/30 border border-yellow-200 dark:border-yellow-700/50 rounded-2xl p-6 shadow-sm animate-fade-in">
                  <h4 className="font-bold text-yellow-800 dark:text-yellow-300 mb-2 flex gap-2"><Sparkles className="w-5 h-5 text-yellow-500" /> Bí Quyết Ghi Nhớ:</h4>
                  <p className="text-yellow-900 dark:text-yellow-100 font-medium leading-relaxed">{mnemonicState.text}</p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="pt-6 border-t border-gray-200 dark:border-gray-700 mt-8">
          {!isChecking ? (
            <button onClick={handleCheckAnswer} disabled={currentSelected.length === 0}
              className="w-full bg-indigo-600 text-white py-4 rounded-xl font-bold text-lg disabled:opacity-50 hover:shadow-lg hover:-translate-y-1 transition-all">
              Khẳng Định Đáp Án
            </button>
          ) : (
            <button onClick={handleNext}
              className="w-full bg-green-500 hover:bg-green-600 text-white py-4 rounded-xl font-bold text-lg flex items-center justify-center gap-2 shadow-lg hover:-translate-y-1 transition-all">
              {currentIndex < sessionQs.length - 1 ? 'Tiếp tục Thí Luyện' : 'Hoàn thành Bế Quan'} <ArrowRight className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
    );
  };

  // ==========================================
  // 🖥 MAIN RENDER
  // ==========================================
  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center">
        <RefreshCw className="w-12 h-12 animate-spin text-indigo-500 mb-4" />
        <p className="text-xl font-black tracking-widest text-indigo-400 animate-pulse">KẾT NỐI TIÊN GIỚI...</p>
      </div>
    );
  }

  if (!user) return renderLogin();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 transition-colors duration-300">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-[100] animate-fade-in-down">
          <div className={`flex items-center gap-3 px-6 py-4 rounded-xl shadow-2xl border-l-4 ${toast.type === 'error' ? 'bg-white dark:bg-gray-800 border-red-500 text-red-700 dark:text-red-400' : 'bg-white dark:bg-gray-800 border-green-500 text-green-700 dark:text-green-400'}`}>
            {toast.type === 'error' ? <AlertCircle className="w-6 h-6 text-red-500" /> : <CheckCircle2 className="w-6 h-6 text-green-500" />}
            <span className="font-medium">{toast.msg}</span>
          </div>
        </div>
      )}

      {/* ⚡ TRIBULATION MODAL */}
      {tribulationModal.isOpen && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4">
          {tribulationModal.isStriking && (
            <div className="fixed inset-0 z-[201] pointer-events-none animate-flash bg-white/20"></div>
          )}
          <div className={`relative z-[202] border-4 rounded-3xl p-8 max-w-lg w-full text-center shadow-2xl transition-all duration-300
            ${tribulationModal.isStriking ? 'animate-shake border-white bg-gray-100 shadow-[0_0_150px_rgba(255,255,255,0.8)]'
              : tribulationModal.result === 'fail' ? 'border-red-500 bg-red-950/50 shadow-[0_0_80px_rgba(239,68,68,0.4)]'
              : tribulationModal.result === 'success' ? 'border-green-500 bg-green-950/50 shadow-[0_0_80px_rgba(34,197,94,0.4)]'
              : 'border-yellow-500 bg-gray-900 shadow-[0_0_80px_rgba(234,179,8,0.4)]'}`}>

            {tribulationModal.isStriking && (
              <div className="absolute inset-0 flex justify-center items-center pointer-events-none overflow-hidden rounded-3xl z-[-1]">
                <Zap className="w-64 h-64 text-yellow-300 animate-strike drop-shadow-[0_0_30px_rgba(255,255,255,1)]" />
              </div>
            )}

            {tribulationModal.result === null ? (
              <div className={`transition-opacity ${tribulationModal.isStriking ? 'opacity-20' : 'opacity-100 animate-fade-in-up'}`}>
                <Zap className="w-20 h-20 text-yellow-500 mx-auto mb-4 animate-bounce" />
                <h2 className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-600 mb-2 tracking-widest uppercase">Độ Kiếp</h2>
                <p className="text-gray-300 text-lg mb-8">Tu vi đã đạt đỉnh phong! Phi thăng lên <strong className="text-white text-xl block mt-2">{tribulationModal.targetLevel?.name}</strong></p>
                <div className="bg-black/60 rounded-2xl p-5 mb-8 text-left border border-gray-700">
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-gray-400">Tỉ lệ thành công:</span>
                    <span className="text-green-400 font-bold text-xl">{(tribulationModal.successRate * 100).toFixed(0)}%</span>
                  </div>
                  <div className="flex justify-between items-center mb-4">
                    <span className="text-gray-400">Tâm ma phản phệ:</span>
                    <span className="text-red-400 font-bold text-xl">{((1 - tribulationModal.successRate) * 100).toFixed(0)}%</span>
                  </div>
                  {userStats.failBonus > 0 && (
                    <div className="bg-green-900/30 text-green-400 p-2 rounded text-sm text-center mb-3 border border-green-800/50">
                      Đạo tâm kiên định: +{(userStats.failBonus * 100).toFixed(0)}% từ lần trước
                    </div>
                  )}
                  <div className="bg-red-900/30 text-red-300 p-3 rounded-lg text-xs leading-relaxed flex items-start gap-2 border border-red-800/50">
                    <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    Cảnh báo: Thất bại sẽ mất 50% tu vi hiện có, nhưng tăng +5% cơ hội lần sau.
                  </div>
                </div>
                <button onClick={handleDoKiep} disabled={tribulationModal.isStriking}
                  className="w-full bg-gradient-to-r from-yellow-600 to-orange-600 hover:from-yellow-500 hover:to-orange-500 text-white font-black text-xl py-5 rounded-xl transition-all transform hover:scale-105 shadow-[0_0_30px_rgba(234,179,8,0.5)] disabled:opacity-50 disabled:scale-100">
                  {tribulationModal.isStriking ? 'ĐANG CHỊU LÔI KIẾP...' : 'NGHÊNH ĐÓN THIÊN KIẾP'}
                </button>
                {!tribulationModal.isStriking && (
                  <button onClick={() => setTribulationModal({ isOpen: false })} className="mt-4 text-gray-500 hover:text-white text-sm font-medium">Tạm thời bế quan thêm (Hủy)</button>
                )}
              </div>
            ) : tribulationModal.result === 'success' ? (
              <div className="animate-fade-in-up">
                <Cloud className="w-24 h-24 text-cyan-400 mx-auto mb-4 animate-pulse" />
                <h2 className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-green-300 to-cyan-400 mb-4">ĐỘT PHÁ THÀNH CÔNG!</h2>
                <p className="text-gray-300 text-lg mb-8">Đạo hữu đã chính thức bước vào <strong className="text-white text-2xl block mt-2">{tribulationModal.targetLevel?.name}</strong></p>
                <button onClick={() => setTribulationModal({ isOpen: false })} className="w-full bg-gradient-to-r from-green-500 to-cyan-500 hover:from-green-400 hover:to-cyan-400 text-white font-bold py-4 rounded-xl">Củng cố tu vi (Tiếp tục)</button>
              </div>
            ) : (
              <div className="animate-fade-in-up">
                <ShieldAlert className="w-24 h-24 text-red-500 mx-auto mb-4 animate-pulse" />
                <h2 className="text-4xl font-black text-red-500 mb-4">ĐỘ KIẾP THẤT BẠI</h2>
                <p className="text-red-200 text-lg mb-6">Đạo tâm không vững, mất đi <strong className="text-red-400 text-2xl block mt-2">{tribulationModal.penaltyXp} Tu vi</strong></p>
                <p className="text-yellow-400 text-sm mb-8 font-medium">Lần độ kiếp sau sẽ được cộng thêm +5% Tỉ lệ thành công.</p>
                <button onClick={() => setTribulationModal({ isOpen: false })} className="w-full bg-red-900 hover:bg-red-800 border border-red-500 text-white font-bold py-4 rounded-xl">Bế quan chữa thương</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* SUMMARY MODAL */}
      {summaryModal.isOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-purple-500/30 rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100 dark:border-gray-800 flex justify-between items-center bg-purple-50 dark:bg-purple-900/20">
              <h2 className="text-xl font-bold flex items-center gap-2 text-purple-700 dark:text-purple-300"><Sparkles className="w-5 h-5" /> {summaryModal.title}</h2>
              <button onClick={() => setSummaryModal({ isOpen: false, isLoading: false, title: '', content: '' })} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-2 rounded-full"><XCircle className="w-5 h-5" /></button>
            </div>
            <div className="p-8 overflow-y-auto flex-1 custom-scrollbar">
              {summaryModal.isLoading ? (
                <div className="flex flex-col items-center justify-center py-20 text-purple-600 dark:text-purple-400">
                  <RefreshCw className="w-12 h-12 animate-spin mb-6" />
                  <p className="font-medium animate-pulse text-lg">Khí linh đang diễn hoá văn tự...</p>
                </div>
              ) : (
                <div className="prose dark:prose-invert max-w-none">
                  <p className="whitespace-pre-wrap leading-relaxed text-gray-700 dark:text-gray-300 text-lg">{summaryModal.content}</p>
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
            <button onClick={() => setCurrentScreen('dashboard')} className="flex items-center gap-2 text-gray-500 hover:text-indigo-500 font-medium mb-8 transition-colors">
              <ArrowRight className="w-4 h-4 rotate-180" /> Trở về Tàng Kinh Các
            </button>
            <div className="bg-white dark:bg-gray-800 p-8 md:p-10 rounded-3xl shadow-2xl border border-gray-100 dark:border-gray-700">
              <h2 className="text-3xl font-black text-gray-900 dark:text-white mb-2 flex items-center gap-3"><Cloud className="text-indigo-500 w-8 h-8" /> Khắc Ghi Ngọc Giản</h2>
              <p className="text-gray-500 dark:text-gray-400 mb-8">Dán tâm pháp vào đây, Khí linh sẽ tự động chia nhỏ thành các tầng để rèn luyện.</p>
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Tên Tâm Pháp</label>
                  <input type="text" value={uploadTitle} onChange={e => setUploadTitle(e.target.value)} placeholder="Ví dụ: Luyện Khí Kỳ - Tập 1..." className="w-full px-5 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Nội dung (Pháp Ngữ)</label>
                  <textarea value={uploadText} onChange={e => setUploadText(e.target.value)} placeholder="Dán nội dung sách vào đây. Khí linh sẽ tự hiểu ngôn ngữ (Anh/Việt) để tạo câu hỏi đúng thứ tiếng đó..." className="w-full h-80 px-5 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none resize-none font-mono text-sm leading-relaxed custom-scrollbar" />
                </div>
                <button onClick={() => saveDocToCloud(uploadTitle, uploadText)} disabled={!uploadText.trim() || isLoading} className="w-full py-5 bg-gradient-to-r from-indigo-600 to-cyan-600 text-white rounded-xl font-black text-lg hover:shadow-lg disabled:opacity-50 transition-all flex items-center justify-center gap-2 transform hover:-translate-y-1">
                  {isLoading ? <RefreshCw className="w-6 h-6 animate-spin" /> : <><Cloud className="w-6 h-6" /> Lưu Chép Lên Thiên Các</>}
                </button>
              </div>
            </div>
          </div>
        )}

        {currentScreen === 'quiz' && renderQuiz()}

        {currentScreen === 'result' && sessionResult && !tribulationModal.isOpen && (
          <div className="max-w-3xl mx-auto px-4 py-16 text-center animate-fade-in">
            <div className="bg-white dark:bg-gray-800 p-10 md:p-14 rounded-3xl shadow-2xl border border-gray-100 dark:border-gray-700 relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/10 to-transparent pointer-events-none"></div>
              <Trophy className="w-20 h-20 text-yellow-500 mx-auto mb-6 relative z-10" />
              <h2 className="text-4xl font-black text-gray-900 dark:text-white mb-2 relative z-10">Bế Quan Hoàn Tất!</h2>
              <p className="text-gray-500 dark:text-gray-400 text-lg mb-10 relative z-10">Đạo tâm kiên định, tu vi tăng trưởng.</p>

              <div className="grid grid-cols-2 gap-6 mb-12 text-center relative z-10">
                <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 p-6 rounded-2xl">
                  <p className="text-gray-500 dark:text-gray-400 font-bold uppercase tracking-wider mb-2 text-sm">Kết Quả</p>
                  <p className="text-4xl font-black text-indigo-600 dark:text-indigo-400">
                    {sessionResult.score}<span className="text-2xl text-gray-400 dark:text-gray-600">/{sessionResult.questions.length}</span>
                  </p>
                </div>
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700/50 p-6 rounded-2xl">
                  <p className="text-yellow-600 dark:text-yellow-500 font-bold uppercase tracking-wider mb-2 text-sm">Tu Vi Thu Được</p>
                  <p className="text-4xl font-black text-yellow-500">+{sessionResult.xpGained} <Star className="inline-block w-6 h-6 -mt-2" /></p>
                </div>
              </div>

              {sessionResult.wrongInSession?.length > 0 && (
                <div className="mb-8 relative z-10">
                  <button
                    onClick={() => {
                      const wrongQsData = sessionResult.questions.filter(q => sessionResult.wrongInSession.includes(q.id));
                      startQuiz('review_session', sessionResult.chapterId, wrongQsData);
                    }}
                    className="w-full bg-red-600 hover:bg-red-500 text-white py-4 rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg transition-transform hover:-translate-y-1">
                    <Target className="w-5 h-5" /> Trảm Tâm Ma ({sessionResult.wrongInSession.length} câu vừa sai)
                  </button>
                  <p className="text-sm text-gray-500 mt-3">* Ôn lại ngay để củng cố tu vi!</p>
                </div>
              )}

              {userStats.xp >= getXpReq(userStats.level) && !getLevelInfo(userStats.level).isMax && (
                <div className="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 p-4 rounded-xl mb-8 font-bold animate-pulse border border-orange-200 dark:border-orange-800">
                  <Zap className="inline-block w-5 h-5 mr-2 -mt-1" /> Tu vi đã đầy! Trở về để Trùng Kích Cảnh Giới!
                </div>
              )}

              <button onClick={() => setCurrentScreen('dashboard')} className="w-full md:w-auto px-12 py-5 bg-gradient-to-r from-gray-800 to-gray-900 dark:from-indigo-600 dark:to-cyan-600 text-white rounded-xl font-bold text-lg hover:shadow-xl transition-all relative z-10">
                Trở về Tàng Kinh Các
              </button>
            </div>
          </div>
        )}

        {currentScreen === 'settings' && (
          <div className="max-w-lg mx-auto px-4 py-8 animate-fade-in">
            <div className="bg-white dark:bg-gray-800 p-8 rounded-3xl border border-gray-100 dark:border-gray-700 shadow-2xl">
              <h2 className="text-2xl font-black text-gray-900 dark:text-white mb-8 flex items-center gap-3"><Settings className="text-indigo-500" /> Trận Pháp Cài Đặt</h2>

              {user && (
                <div className="flex items-center gap-4 p-4 bg-gray-50 dark:bg-gray-900 rounded-2xl mb-8">
                  {user.photoURL && <img src={user.photoURL} referrerPolicy="no-referrer" alt="avatar" className="w-12 h-12 rounded-full border-2 border-indigo-400" />}
                  <div>
                    <p className="font-bold text-gray-900 dark:text-white">{user.displayName}</p>
                    <p className="text-sm text-gray-500">{user.email}</p>
                  </div>
                </div>
              )}

              <div className="space-y-8">
                <div>
                  <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Gemini API Key (Tùy chọn)</label>
                  <input type="password" value={settings.apiKey} onChange={e => updateSettings({ apiKey: e.target.value })} className="w-full px-5 py-3 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 rounded-xl dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all" placeholder="Bỏ trống để dùng mặc định" />
                  <p className="text-xs text-gray-500 mt-1">Có API Key riêng sẽ dùng gemini-1.5-flash, không có sẽ dùng model mặc định.</p>
                </div>

                <div className="h-px bg-gray-200 dark:bg-gray-700"></div>

                <div className="flex items-center justify-between">
                  <span className="font-bold text-gray-700 dark:text-gray-300">Giao diện tối</span>
                  <button onClick={() => updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
                    className={`w-14 h-7 rounded-full transition-colors relative ${settings.theme === 'dark' ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                    <div className={`w-5 h-5 bg-white rounded-full absolute top-1 transition-transform ${settings.theme === 'dark' ? 'translate-x-8' : 'translate-x-1'}`}></div>
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-gray-700 dark:text-gray-300">Hiển thị đồng hồ</span>
                  <button onClick={() => updateSettings({ timerEnabled: !settings.timerEnabled })}
                    className={`w-14 h-7 rounded-full transition-colors relative ${settings.timerEnabled ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                    <div className={`w-5 h-5 bg-white rounded-full absolute top-1 transition-transform ${settings.timerEnabled ? 'translate-x-8' : 'translate-x-1'}`}></div>
                  </button>
                </div>

                <div className="h-px bg-gray-200 dark:bg-gray-700"></div>

                <div>
                  <p className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Bảo Lưu Nguyên Thần (Export / Import)</p>
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={handleExportData} className="flex items-center justify-center gap-2 py-3 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-600 transition-all font-medium">
                      <Download className="w-5 h-5" /> Xuất Dữ Liệu
                    </button>
                    <label className="flex items-center justify-center gap-2 py-3 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-xl hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-all font-medium cursor-pointer">
                      <UploadCloud className="w-5 h-5" /> Nhập Dữ Liệu
                      <input type="file" className="hidden" accept=".json" onChange={handleImportData} />
                    </label>
                  </div>
                  <p className="text-xs text-gray-500 mt-2 leading-relaxed italic">* Xuất dữ liệu trước khi update app để bảo toàn tu vi. Sau update, nhập lại file cũ để khôi phục.</p>
                </div>

                <div className="h-px bg-gray-200 dark:bg-gray-700"></div>

                <div>
                  <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Số câu Tiểu Chu Thiên</label>
                  <select value={settings.defaultCount} onChange={e => updateSettings({ defaultCount: parseInt(e.target.value) })}
                    className="w-full px-5 py-3 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 rounded-xl dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none cursor-pointer">
                    <option value={5}>5 câu (Sơ nhập)</option>
                    <option value={10}>10 câu (Khổ tu)</option>
                    <option value={20}>20 câu (Sinh tử quan)</option>
                  </select>
                </div>

                <button onClick={() => setCurrentScreen('dashboard')} className="w-full bg-gray-900 hover:bg-gray-800 dark:bg-indigo-600 dark:hover:bg-indigo-500 text-white py-4 rounded-xl font-bold text-lg transition-all">Lưu Lại Trận Pháp</button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* GLOBAL LOADING */}
      {isLoading && (
        <div className="fixed inset-0 bg-gray-900/80 backdrop-blur-sm z-[150] flex flex-col items-center justify-center text-white">
          <div className="relative">
            <RefreshCw className="w-16 h-16 animate-spin text-indigo-500 relative z-10" />
            <div className="absolute inset-0 bg-indigo-500 blur-xl opacity-50 rounded-full"></div>
          </div>
          <p className="text-2xl font-black mt-6 tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-indigo-300 to-cyan-300 animate-pulse">{loadingMsg}</p>
        </div>
      )}
    </div>
  );
}
