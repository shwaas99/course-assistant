import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import type { MCPServersState } from "agents";
import type { ChatAgent } from "./server";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Switch } from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BrainIcon,
  CaretDownIcon,
  BugIcon,
  PlugsConnectedIcon,
  PlusIcon,
  SignInIcon,
  XIcon,
  WrenchIcon,
  PaperclipIcon,
  ImageIcon,
  BookOpenIcon,
  GraduationCapIcon,
  UploadSimpleIcon,
  FileTextIcon,
  ListBulletsIcon,
  ArrowRightIcon,
  SparkleIcon
} from "@phosphor-icons/react";

// ── Types ──────────────────────────────────────────────────────────────────

interface Attachment {
  id: string;
  file: File;
  preview: string;
  mediaType: string;
}

type Course = { name: string; materials: string[] };
type CourseState = { courses: Course[]; activeCourse: string | null };

// Course colors — each course gets a consistent hue from this palette
const COURSE_COLORS = [
  { bg: "#f97316", glow: "rgba(249,115,22,0.35)", dim: "rgba(249,115,22,0.12)", text: "#fff" },
  { bg: "#8b5cf6", glow: "rgba(139,92,246,0.35)", dim: "rgba(139,92,246,0.12)", text: "#fff" },
  { bg: "#06b6d4", glow: "rgba(6,182,212,0.35)",  dim: "rgba(6,182,212,0.12)",  text: "#fff" },
  { bg: "#ec4899", glow: "rgba(236,72,153,0.35)", dim: "rgba(236,72,153,0.12)", text: "#fff" },
  { bg: "#10b981", glow: "rgba(16,185,129,0.35)", dim: "rgba(16,185,129,0.12)", text: "#fff" },
  { bg: "#f59e0b", glow: "rgba(245,158,11,0.35)", dim: "rgba(245,158,11,0.12)", text: "#fff" },
];

function courseColor(name: string, index: number) {
  return COURSE_COLORS[index % COURSE_COLORS.length];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function createAttachment(file: File): Attachment {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    preview: URL.createObjectURL(file),
    mediaType: file.type || "application/octet-stream"
  };
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function fileToText(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsText(file);
  });
}

// ── Theme Toggle ───────────────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);
  return (
    <button onClick={toggle} aria-label="Toggle theme" className="icon-btn">
      {dark ? <SunIcon size={15} /> : <MoonIcon size={15} />}
    </button>
  );
}

// ── Tool View ──────────────────────────────────────────────────────────────

function ToolPartView({
  part,
  addToolApprovalResponse
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (r: { id: string; approved: boolean }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);

  if (part.state === "output-available") {
    return (
      <div className="tool-bubble">
        <div className="tool-header">
          <GearIcon size={11} />
          <span>{toolName}</span>
          <span className="tool-badge">done</span>
        </div>
        <pre className="tool-output">{JSON.stringify(part.output, null, 2)}</pre>
      </div>
    );
  }

  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="tool-bubble tool-bubble--warn">
        <div className="tool-header" style={{ color: "var(--warn)" }}>
          <GearIcon size={11} />
          <span>Approval required — {toolName}</span>
        </div>
        <pre className="tool-output">{JSON.stringify(part.input, null, 2)}</pre>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="btn-approve" onClick={() => approvalId && addToolApprovalResponse({ id: approvalId, approved: true })}>
            <CheckCircleIcon size={12} /> Approve
          </button>
          <button className="btn-reject" onClick={() => approvalId && addToolApprovalResponse({ id: approvalId, approved: false })}>
            <XCircleIcon size={12} /> Reject
          </button>
        </div>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="tool-bubble tool-bubble--running">
        <GearIcon size={11} className="spin" />
        <span>Running {toolName}…</span>
      </div>
    );
  }

  return null;
}

// ── Sidebar ────────────────────────────────────────────────────────────────

function Sidebar({
  courseState,
  onAddCourse,
  onSelectCourse,
  onRemoveCourse,
  onUploadMaterial,
  collapsed
}: {
  courseState: CourseState;
  onAddCourse: (name: string) => void;
  onSelectCourse: (name: string) => void;
  onRemoveCourse: (name: string) => void;
  onUploadMaterial: (course: string, text: string, label: string) => void;
  collapsed: boolean;
}) {
  const [newCourse, setNewCourse] = useState("");
  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleAdd = () => {
    const name = newCourse.trim();
    if (!name) return;
    onAddCourse(name);
    setNewCourse("");
    setAdding(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !uploadTarget) return;
    setUploading(uploadTarget);
    const text = await fileToText(file);
    onUploadMaterial(uploadTarget, text, file.name);
    setUploading(null);
    setUploadTarget(null);
    e.target.value = "";
  };

  return (
    <>
      <input ref={fileRef} type="file" accept=".txt,.md,.pdf" style={{ display: "none" }} onChange={handleFileUpload} />
      <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}>
        {/* Header */}
        <div className="sidebar-header">
          <div className="sidebar-title">
            <GraduationCapIcon size={15} weight="bold" />
            <span>Courses</span>
          </div>
          <button className="icon-btn icon-btn--accent" onClick={() => setAdding(true)} aria-label="Add course">
            <PlusIcon size={13} weight="bold" />
          </button>
        </div>

        {/* Add input */}
        {adding && (
          <div className="sidebar-add">
            <input
              autoFocus
              value={newCourse}
              onChange={e => setNewCourse(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") setAdding(false); }}
              placeholder="e.g. Linear Algebra"
              className="add-input"
            />
            <div className="add-actions">
              <button className="btn-primary btn-sm" onClick={handleAdd}>Add</button>
              <button className="btn-ghost btn-sm" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Course list */}
        <div className="course-list">
          {courseState.courses.length === 0 && !adding && (
            <div className="course-empty">
              <BookOpenIcon size={26} />
              <span>Add your first course</span>
            </div>
          )}

          {courseState.courses.map((course, idx) => {
            const active = courseState.activeCourse === course.name;
            const color = courseColor(course.name, idx);
            return (
              <div
                key={course.name}
                className={`course-item${active ? " course-item--active" : ""}`}
                style={active ? {
                  background: color.dim,
                  borderColor: color.bg,
                  boxShadow: `0 0 12px ${color.glow}`
                } : {}}
                onClick={() => onSelectCourse(course.name)}
              >
                <div className="course-dot" style={{ background: color.bg, boxShadow: active ? `0 0 8px ${color.glow}` : "none" }} />
                <span className="course-name">{course.name}</span>
                <button
                  className="course-remove"
                  onClick={e => { e.stopPropagation(); onRemoveCourse(course.name); }}
                  aria-label="Remove course"
                >
                  <XIcon size={10} />
                </button>

                {active && (
                  <div className="course-materials" onClick={e => e.stopPropagation()}>
                    <div className="materials-label">Materials</div>
                    {course.materials.length === 0
                      ? <div className="materials-empty">No files yet</div>
                      : course.materials.map((_, i) => (
                          <div key={i} className="material-item">
                            <FileTextIcon size={10} />
                            <span>Document {i + 1}</span>
                          </div>
                        ))
                    }
                    <button
                      className="upload-btn"
                      disabled={uploading === course.name}
                      onClick={() => { setUploadTarget(course.name); setTimeout(() => fileRef.current?.click(), 50); }}
                    >
                      <UploadSimpleIcon size={11} />
                      {uploading === course.name ? "Uploading…" : "Upload file"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}

// ── Suggested prompts ──────────────────────────────────────────────────────

function suggestedPrompts(activeCourse: string | null) {
  if (!activeCourse) return [
    "Add my courses for this semester",
    "I'm taking Calculus, Physics, and CS101",
    "What can you help me with?"
  ];
  return [
    `Explain the current topic in ${activeCourse}`,
    `Quiz me on ${activeCourse}`,
    `Summarize my ${activeCourse} materials`,
    `What should I study next in ${activeCourse}?`
  ];
}

// ── COURSE-STATE-REFRESHING TOOLS ──────────────────────────────────────────
// These are the tool names that mutate course state on the server.
// When we see their output, we re-fetch state so the sidebar updates instantly.
const COURSE_MUTATING_TOOLS = new Set([
  "addCourseByName",
  "switchCourse",
  "listCourses"
]);

// ── Chat ───────────────────────────────────────────────────────────────────

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [courseState, setCourseState] = useState<CourseState>({ courses: [], activeCourse: null });
  const [mcpState, setMcpState] = useState<MCPServersState>({ prompts: [], resources: [], servers: {}, tools: [] });
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [isAddingMcp, setIsAddingMcp] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mcpPanelRef = useRef<HTMLDivElement>(null);
  const toasts = useKumoToastManager();

  // Track which message IDs we've already processed for course state refresh
  const processedToolOutputs = useRef(new Set<string>());

  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback((e: Event) => console.error("WS error:", e), []),
    onMcpUpdate: useCallback((s: MCPServersState) => setMcpState(s), []),
    onMessage: useCallback((message: MessageEvent) => {
      try {
        const data = JSON.parse(String(message.data));
        if (data.type === "scheduled-task") {
          toasts.add({ title: "Reminder", description: data.description, timeout: 0 });
        }
      } catch { /* not our event */ }
    }, [toasts])
  });

  // Load course state once on connect
  useEffect(() => {
    if (!connected) return;
    agent.stub.getCourseState().then((s: CourseState) => setCourseState(s)).catch(() => {});
  }, [connected]);

  // Close MCP panel on outside click
  useEffect(() => {
    if (!showMcpPanel) return;
    const h = (e: MouseEvent) => {
      if (mcpPanelRef.current && !mcpPanelRef.current.contains(e.target as Node))
        setShowMcpPanel(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showMcpPanel]);

  // ── Course operations (called from sidebar) ────────────────────────────
  const handleAddCourse = async (name: string) => {
    const next = await agent.stub.addCourse(name);
    setCourseState(next);
  };
  const handleSelectCourse = async (name: string) => {
    const next = await agent.stub.selectCourse(name);
    setCourseState(next);
  };
  const handleRemoveCourse = async (name: string) => {
    const next = await agent.stub.removeCourse(name);
    setCourseState(next);
  };
  const handleUploadMaterial = async (course: string, text: string, label: string) => {
    const next = await agent.stub.uploadMaterial(course, text, label);
    setCourseState(next);
    toasts.add({ title: "Uploaded", description: `${label} added to ${course}` });
  };

  // ── MCP ────────────────────────────────────────────────────────────────
  const handleAddMcp = async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setIsAddingMcp(true);
    try { await agent.stub.addServer(mcpName.trim(), mcpUrl.trim()); setMcpName(""); setMcpUrl(""); }
    catch (e) { console.error(e); }
    finally { setIsAddingMcp(false); }
  };

  // ── Chat hook ──────────────────────────────────────────────────────────
  const { messages, sendMessage, clearHistory, addToolApprovalResponse, stop, status } =
    useAgentChat({
      agent,
      onToolCall: async (event) => {
        if ("addToolOutput" in event && event.toolCall.toolName === "getUserTimezone") {
          event.addToolOutput({
            toolCallId: event.toolCall.toolCallId,
            output: {
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              localTime: new Date().toLocaleTimeString()
            }
          });
        }
      }
    });

  const isStreaming = status === "streaming" || status === "submitted";

  // ── KEY FIX: Watch messages for course-mutating tool outputs ───────────
  // When addCourseByName / switchCourse fire and complete, re-fetch course
  // state so the sidebar updates without a page reload.
  useEffect(() => {
    let shouldRefresh = false;
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (!isToolUIPart(part)) continue;
        if (part.state !== "output-available") continue;
        const name = getToolName(part);
        if (!COURSE_MUTATING_TOOLS.has(name)) continue;
        // Use toolCallId as a unique key so we only refresh once per tool call
        const key = part.toolCallId;
        if (!processedToolOutputs.current.has(key)) {
          processedToolOutputs.current.add(key);
          shouldRefresh = true;
        }
      }
    }
    if (shouldRefresh && connected) {
      agent.stub.getCourseState()
        .then((s: CourseState) => setCourseState(s))
        .catch(() => {});
    }
  }, [messages, connected]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { if (!isStreaming) textareaRef.current?.focus(); }, [isStreaming]);

  // ── File / drag handling ───────────────────────────────────────────────
  const addFiles = useCallback((files: FileList | File[]) => {
    const imgs = Array.from(files).filter(f => f.type.startsWith("image/"));
    if (!imgs.length) return;
    setAttachments(prev => [...prev, ...imgs.map(createAttachment)]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => {
      const a = prev.find(x => x.id === id);
      if (a) URL.revokeObjectURL(a.preview);
      return prev.filter(x => x.id !== id);
    });
  }, []);

  const handleDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.types.includes("Files")) setIsDragging(true); }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (e.currentTarget === e.target) setIsDragging(false); }, []);
  const handleDrop      = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }, [addFiles]);
  const handlePaste     = useCallback((e: React.ClipboardEvent) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData?.items ?? [])) { if (item.kind === "file") { const f = item.getAsFile(); if (f) files.push(f); } }
    if (files.length) { e.preventDefault(); addFiles(files); }
  }, [addFiles]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && !attachments.length) || isStreaming) return;
    setInput("");
    const parts: Array<{ type: "text"; text: string } | { type: "file"; mediaType: string; url: string }> = [];
    if (text) parts.push({ type: "text", text });
    for (const att of attachments) {
      const uri = await fileToDataUri(att.file);
      parts.push({ type: "file", mediaType: att.mediaType, url: uri });
    }
    attachments.forEach(a => URL.revokeObjectURL(a.preview));
    setAttachments([]);
    sendMessage({ role: "user", parts });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, attachments, isStreaming, sendMessage]);

  const activeName = courseState.activeCourse;
  const activeCourseIdx = courseState.courses.findIndex(c => c.name === activeName);
  const activeColor = activeCourseIdx >= 0 ? courseColor(activeName!, activeCourseIdx) : null;
  const serverEntries = Object.entries(mcpState.servers);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Instrument+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --font-display: 'Syne', sans-serif;
          --font-body:    'Instrument Sans', sans-serif;
          --font-mono:    'JetBrains Mono', monospace;

          --bg:         #0d0f1a;
          --bg2:        #12152a;
          --surface:    #1a1e35;
          --surface2:   #222748;
          --border:     rgba(255,255,255,0.08);
          --border2:    rgba(255,255,255,0.14);

          --text:       #eef0ff;
          --text-soft:  #a8adc9;
          --muted:      #5a5f80;

          --amber:      #f9a825;
          --amber-dim:  rgba(249,168,37,0.12);
          --amber-glow: rgba(249,168,37,0.3);
          --coral:      #ff6b6b;
          --teal:       #00d4aa;

          --warn:       #f59e0b;
          --success:    #10b981;

          --sidebar-w:  252px;
        }

        body { font-family: var(--font-body); background: var(--bg); color: var(--text); overflow: hidden; }

        /* ── Layout ── */
        .app { display: flex; height: 100vh; position: relative; overflow: hidden; }

        /* Animated mesh background */
        .app::before {
          content: '';
          position: fixed; inset: 0; z-index: 0; pointer-events: none;
          background:
            radial-gradient(ellipse 60% 40% at 10% 20%, rgba(139,92,246,0.08) 0%, transparent 60%),
            radial-gradient(ellipse 50% 50% at 90% 80%, rgba(249,168,37,0.06) 0%, transparent 60%),
            radial-gradient(ellipse 40% 60% at 50% 50%, rgba(0,212,170,0.04) 0%, transparent 60%);
        }

        /* ── Sidebar ── */
        .sidebar {
          position: relative; z-index: 10;
          width: var(--sidebar-w); min-width: var(--sidebar-w);
          background: var(--bg2);
          border-right: 1px solid var(--border);
          display: flex; flex-direction: column;
          overflow: hidden;
          transition: width 0.22s cubic-bezier(.4,0,.2,1), min-width 0.22s cubic-bezier(.4,0,.2,1);
        }
        .sidebar--collapsed { width: 0; min-width: 0; }

        .sidebar-header {
          padding: 18px 16px 14px;
          border-bottom: 1px solid var(--border);
          display: flex; align-items: center; justify-content: space-between;
          flex-shrink: 0;
        }
        .sidebar-title {
          display: flex; align-items: center; gap: 8px;
          font-family: var(--font-display);
          font-size: 11px; font-weight: 700;
          letter-spacing: 0.1em; text-transform: uppercase;
          color: var(--text-soft);
        }
        .sidebar-title svg { color: var(--amber); }

        .sidebar-add {
          padding: 12px 14px;
          border-bottom: 1px solid var(--border);
          background: rgba(255,255,255,0.02);
        }
        .add-input {
          width: 100%; padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid var(--amber);
          background: var(--surface);
          color: var(--text); font-size: 13px;
          font-family: var(--font-body);
          outline: none;
          box-shadow: 0 0 10px var(--amber-glow);
        }
        .add-actions { display: flex; gap: 6px; margin-top: 8px; }

        .course-list { flex: 1; overflow-y: auto; padding: 10px 10px; }

        .course-empty {
          padding: 36px 16px; text-align: center;
          color: var(--muted); font-size: 13px;
          display: flex; flex-direction: column; align-items: center; gap: 10px;
        }

        .course-item {
          border-radius: 10px; margin-bottom: 5px;
          border: 1px solid transparent;
          cursor: pointer; overflow: hidden;
          transition: all 0.18s ease;
          background: transparent;
        }
        .course-item:hover { background: var(--surface); border-color: var(--border2); }
        .course-item--active { border-color: transparent; }

        .course-item > .course-dot,
        .course-item > .course-name,
        .course-item > .course-remove {
          /* inline row items */
        }

        /* The first row of a course item */
        .course-item-row {
          padding: 9px 11px;
          display: flex; align-items: center; gap: 9px;
        }
        .course-dot {
          width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
          transition: box-shadow 0.2s;
        }
        .course-name {
          flex: 1; font-size: 13px; font-weight: 500;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          color: var(--text-soft);
          transition: color 0.15s;
        }
        .course-item--active .course-name { color: var(--text); font-weight: 600; }
        .course-remove {
          width: 18px; height: 18px; border-radius: 4px;
          border: none; background: transparent; color: var(--muted);
          cursor: pointer; display: flex; align-items: center; justify-content: center;
          opacity: 0; transition: opacity 0.15s;
          flex-shrink: 0;
        }
        .course-item:hover .course-remove,
        .course-item--active .course-remove { opacity: 1; }

        .course-materials {
          padding: 4px 11px 11px 28px;
        }
        .materials-label {
          font-size: 10px; font-weight: 700; letter-spacing: 0.07em;
          text-transform: uppercase; color: var(--muted); margin-bottom: 6px;
        }
        .materials-empty { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
        .material-item {
          display: flex; align-items: center; gap: 6px;
          font-size: 11px; color: var(--text-soft); margin-bottom: 3px;
        }
        .upload-btn {
          margin-top: 6px; width: 100%; padding: 6px;
          border-radius: 7px; border: 1px dashed var(--border2);
          background: transparent; color: var(--muted);
          font-size: 11px; cursor: pointer;
          display: flex; align-items: center; justify-content: center; gap: 5px;
          font-family: var(--font-body);
          transition: all 0.15s;
        }
        .upload-btn:hover { border-color: var(--amber); color: var(--amber); }

        /* ── Main ── */
        .main {
          flex: 1; display: flex; flex-direction: column;
          min-width: 0; position: relative; z-index: 1;
        }

        /* ── Header ── */
        .header {
          height: 58px; padding: 0 22px;
          border-bottom: 1px solid var(--border);
          background: rgba(13,15,26,0.85);
          backdrop-filter: blur(12px);
          display: flex; align-items: center; justify-content: space-between;
          flex-shrink: 0;
          position: relative;
        }
        .header-left { display: flex; align-items: center; gap: 12px; }
        .header-right { display: flex; align-items: center; gap: 8px; }

        .wordmark {
          font-family: var(--font-display);
          font-size: 17px; font-weight: 800;
          letter-spacing: -0.02em;
          background: linear-gradient(135deg, #eef0ff 0%, var(--amber) 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .active-pill {
          font-size: 12px; font-weight: 600;
          padding: 3px 11px; border-radius: 20px;
          border: 1px solid;
          transition: all 0.2s;
          font-family: var(--font-display);
        }

        .divider { width: 1px; height: 18px; background: var(--border2); }

        /* ── Messages ── */
        .messages-scroll { flex: 1; overflow-y: auto; }
        .messages-inner { max-width: 740px; margin: 0 auto; padding: 36px 24px; }

        /* ── Empty state ── */
        .empty-state { text-align: center; padding-top: 56px; }
        .empty-icon {
          width: 60px; height: 60px; border-radius: 18px;
          background: var(--surface); border: 1px solid var(--border2);
          display: inline-flex; align-items: center; justify-content: center;
          margin-bottom: 22px;
          box-shadow: 0 0 30px rgba(249,168,37,0.1);
        }
        .empty-title {
          font-family: var(--font-display);
          font-size: 26px; font-weight: 800;
          letter-spacing: -0.03em;
          margin-bottom: 10px;
          background: linear-gradient(135deg, var(--text) 0%, var(--text-soft) 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .empty-sub { font-size: 14px; color: var(--text-soft); line-height: 1.6; margin-bottom: 32px; }

        .prompts-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
        .prompt-chip {
          padding: 8px 16px; border-radius: 22px;
          border: 1px solid var(--border2);
          background: var(--surface);
          color: var(--text-soft); font-size: 13px;
          cursor: pointer; font-family: var(--font-body);
          display: inline-flex; align-items: center; gap: 7px;
          transition: all 0.18s;
        }
        .prompt-chip:hover {
          border-color: var(--amber); color: var(--text);
          background: var(--amber-dim);
          box-shadow: 0 0 14px var(--amber-glow);
          transform: translateY(-1px);
        }
        .prompt-chip svg { color: var(--amber); }

        /* ── Message bubbles ── */
        .message-wrap { margin-bottom: 22px; animation: msgIn 0.2s ease both; }
        @keyframes msgIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        .bubble-user {
          display: flex; justify-content: flex-end;
        }
        .bubble-user-inner {
          max-width: 72%;
          padding: 11px 16px;
          border-radius: 18px 18px 4px 18px;
          background: linear-gradient(135deg, var(--surface2) 0%, #2d3360 100%);
          border: 1px solid var(--border2);
          font-size: 14px; line-height: 1.6; color: var(--text);
        }

        .bubble-assistant { display: flex; justify-content: flex-start; }
        .bubble-assistant-inner { max-width: 84%; font-size: 14px; line-height: 1.7; color: var(--text); }

        .assistant-label {
          font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
          text-transform: uppercase; margin-bottom: 8px;
          font-family: var(--font-display);
        }

        /* ── Tool bubbles ── */
        .tool-bubble {
          display: inline-flex; flex-direction: column;
          padding: 8px 12px; border-radius: 8px;
          border: 1px solid var(--border2);
          background: var(--surface);
          font-family: var(--font-mono);
          font-size: 11px; color: var(--text-soft);
          margin-bottom: 6px; max-width: 80%;
        }
        .tool-bubble--warn { border-color: var(--warn); }
        .tool-bubble--running {
          display: inline-flex; flex-direction: row; align-items: center; gap: 8px;
          padding: 7px 12px;
        }
        .tool-header {
          display: flex; align-items: center; gap: 6px;
          font-weight: 600; margin-bottom: 5px;
        }
        .tool-badge {
          font-size: 9px; padding: 1px 6px; border-radius: 4px;
          background: var(--amber-dim); color: var(--amber);
          font-family: var(--font-mono);
        }
        .tool-output { font-size: 10px; opacity: 0.65; white-space: pre-wrap; margin: 0; }

        /* ── Thinking dots ── */
        .thinking { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; margin-bottom: 16px; }
        .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--amber); display: inline-block; }
        .dot:nth-child(1) { animation: bob 0.9s 0.0s ease-in-out infinite alternate; }
        .dot:nth-child(2) { animation: bob 0.9s 0.15s ease-in-out infinite alternate; }
        .dot:nth-child(3) { animation: bob 0.9s 0.30s ease-in-out infinite alternate; }
        @keyframes bob { from { transform: translateY(0); opacity: 0.4; } to { transform: translateY(-4px); opacity: 1; } }

        /* ── Input bar ── */
        .input-area {
          border-top: 1px solid var(--border);
          background: rgba(13,15,26,0.9);
          backdrop-filter: blur(12px);
          padding: 14px 22px 18px;
          flex-shrink: 0;
        }
        .input-box {
          display: flex; align-items: flex-end; gap: 10px;
          padding: 10px 14px;
          border-radius: 14px;
          border: 1px solid var(--border2);
          background: var(--surface);
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .input-box:focus-within {
          border-color: rgba(249,168,37,0.5);
          box-shadow: 0 0 20px var(--amber-glow);
        }
        .input-textarea {
          flex: 1; resize: none; border: none; outline: none;
          background: transparent; color: var(--text);
          font-size: 14px; font-family: var(--font-body);
          line-height: 1.6; max-height: 140px;
        }
        .input-textarea::placeholder { color: var(--muted); }
        .input-hint { text-align: center; margin-top: 8px; font-size: 11px; color: var(--muted); }

        /* ── Attachment thumbnails ── */
        .attachments { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
        .att-thumb { position: relative; }
        .att-thumb img { height: 58px; width: 58px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border2); }
        .att-remove {
          position: absolute; top: 2px; right: 2px;
          width: 16px; height: 16px; border-radius: 50%;
          background: var(--text); color: var(--bg);
          border: none; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
        }

        /* ── Buttons ── */
        .icon-btn {
          width: 32px; height: 32px; border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--surface); color: var(--muted);
          cursor: pointer; display: flex; align-items: center; justify-content: center;
          transition: all 0.15s;
        }
        .icon-btn:hover { border-color: var(--border2); color: var(--text); }
        .icon-btn--accent { border-color: var(--border2); color: var(--amber); }
        .icon-btn--accent:hover { border-color: var(--amber); box-shadow: 0 0 10px var(--amber-glow); }

        .btn-primary {
          padding: 6px 14px; border-radius: 7px;
          background: linear-gradient(135deg, var(--amber), #f97316);
          color: #0d0f1a; border: none; font-size: 12px; font-weight: 700;
          cursor: pointer; font-family: var(--font-body);
          transition: all 0.15s;
        }
        .btn-primary:hover { box-shadow: 0 0 14px var(--amber-glow); transform: translateY(-1px); }

        .btn-ghost {
          padding: 6px 14px; border-radius: 7px;
          background: transparent; color: var(--muted);
          border: 1px solid var(--border2); font-size: 12px;
          cursor: pointer; font-family: var(--font-body);
          transition: all 0.15s;
        }
        .btn-ghost:hover { color: var(--text); border-color: var(--border2); }
        .btn-sm { padding: 5px 12px; font-size: 11px; }

        .send-btn {
          width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
          border: none; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: all 0.15s;
        }
        .send-btn--active {
          background: linear-gradient(135deg, var(--amber), #f97316);
          color: #0d0f1a;
          box-shadow: 0 0 16px var(--amber-glow);
        }
        .send-btn--active:hover { transform: scale(1.05); }
        .send-btn--inactive {
          background: var(--surface2); color: var(--muted); cursor: default;
        }
        .stop-btn {
          width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
          border: 1px solid var(--border2); background: var(--surface);
          color: var(--coral); cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: all 0.15s;
        }
        .stop-btn:hover { border-color: var(--coral); box-shadow: 0 0 10px rgba(255,107,107,0.3); }

        .btn-approve {
          padding: 5px 12px; border-radius: 6px; font-size: 12px;
          background: var(--teal); color: #0d0f1a; border: none;
          cursor: pointer; font-family: var(--font-body); font-weight: 600;
          display: inline-flex; align-items: center; gap: 5px;
        }
        .btn-reject {
          padding: 5px 12px; border-radius: 6px; font-size: 12px;
          background: transparent; color: var(--muted); border: 1px solid var(--border2);
          cursor: pointer; font-family: var(--font-body);
          display: inline-flex; align-items: center; gap: 5px;
        }

        /* ── Header button ── */
        .hdr-btn {
          height: 30px; padding: 0 11px; border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--surface); color: var(--text-soft);
          cursor: pointer; font-size: 12px; font-family: var(--font-body); font-weight: 500;
          display: flex; align-items: center; gap: 6px;
          transition: all 0.15s;
        }
        .hdr-btn:hover { border-color: var(--border2); color: var(--text); }

        .conn-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .conn-dot--on  { background: var(--teal); box-shadow: 0 0 6px rgba(0,212,170,0.5); }
        .conn-dot--off { background: var(--muted); }

        /* ── MCP panel ── */
        .mcp-panel {
          position: absolute; right: 0; top: calc(100% + 8px);
          width: 360px; z-index: 100;
          background: var(--bg2);
          border: 1px solid var(--border2);
          border-radius: 14px;
          box-shadow: 0 16px 48px rgba(0,0,0,0.5);
          padding: 16px;
        }
        .mcp-input {
          width: 100%; padding: 7px 10px; border-radius: 7px;
          border: 1px solid var(--border2); background: var(--surface);
          color: var(--text); font-size: 12px; font-family: var(--font-body);
          outline: none;
        }
        .mcp-input:focus { border-color: var(--amber); box-shadow: 0 0 8px var(--amber-glow); }
        .mcp-server-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: 8px 10px; border-radius: 8px;
          border: 1px solid var(--border); margin-bottom: 6px;
        }

        /* ── Drag overlay ── */
        .drag-overlay {
          position: fixed; inset: 0; z-index: 200;
          display: flex; align-items: center; justify-content: center;
          background: rgba(13,15,26,0.88);
          border: 2px dashed var(--amber);
          margin: 12px; border-radius: 18px;
          pointer-events: none; flex-direction: column; gap: 12px;
          color: var(--amber);
          font-family: var(--font-display); font-size: 20px; font-weight: 700;
          box-shadow: inset 0 0 60px var(--amber-glow);
        }

        /* ── Scrollbar ── */
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--surface2); border-radius: 99px; }

        /* ── Animations ── */
        .spin { animation: spin 1.4s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* ── Reasoning block ── */
        .reasoning-block {
          border-radius: 9px; overflow: hidden;
          border: 1px solid rgba(139,92,246,0.25);
          background: rgba(139,92,246,0.06);
          margin-bottom: 8px;
        }
        .reasoning-summary {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 12px; cursor: pointer;
          font-size: 12px; color: var(--text-soft); list-style: none;
        }
        .reasoning-pre {
          font-size: 11px; color: var(--text-soft);
          padding: 8px 12px; white-space: pre-wrap;
          font-family: var(--font-mono);
        }
      `}</style>

      <div
        className="app"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="drag-overlay">
            <ImageIcon size={38} />
            Drop images here
          </div>
        )}

        {/* ── Sidebar ── */}
        <Sidebar
          courseState={courseState}
          onAddCourse={handleAddCourse}
          onSelectCourse={handleSelectCourse}
          onRemoveCourse={handleRemoveCourse}
          onUploadMaterial={handleUploadMaterial}
          collapsed={sidebarCollapsed}
        />

        {/* ── Main ── */}
        <div className="main">

          {/* Header */}
          <header className="header">
            <div className="header-left">
              <button className="icon-btn" onClick={() => setSidebarCollapsed(v => !v)} aria-label="Toggle sidebar">
                <ListBulletsIcon size={15} />
              </button>
              <div className="divider" />
              <span className="wordmark">Course Assistant</span>
              {activeName && activeColor && (
                <>
                  <span style={{ color: "var(--border2)", fontSize: 16 }}>/</span>
                  <span
                    className="active-pill"
                    style={{
                      color: activeColor.bg,
                      borderColor: activeColor.bg,
                      background: activeColor.dim,
                      boxShadow: `0 0 10px ${activeColor.glow}`
                    }}
                  >
                    {activeName}
                  </span>
                </>
              )}
            </div>

            <div className="header-right">
              {/* Connection */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div className={`conn-dot ${connected ? "conn-dot--on" : "conn-dot--off"}`} />
                <span style={{ fontSize: 12, color: "var(--text-soft)" }}>
                  {connected ? "Connected" : "Connecting"}
                </span>
              </div>
              <div className="divider" />

              {/* Debug */}
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <BugIcon size={12} style={{ color: "var(--muted)" }} />
                <Switch checked={showDebug} onCheckedChange={setShowDebug} size="sm" />
              </div>

              <ThemeToggle />

              {/* MCP */}
              <div style={{ position: "relative" }} ref={mcpPanelRef}>
                <button className="hdr-btn" onClick={() => setShowMcpPanel(v => !v)}>
                  <PlugsConnectedIcon size={13} />
                  MCP
                  {mcpState.tools.length > 0 && (
                    <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "var(--amber-dim)", color: "var(--amber)", fontWeight: 700 }}>
                      {mcpState.tools.length}
                    </span>
                  )}
                </button>

                {showMcpPanel && (
                  <div className="mcp-panel">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-display)" }}>MCP Servers</span>
                      <button className="icon-btn" style={{ width: 24, height: 24, borderRadius: 6 }} onClick={() => setShowMcpPanel(false)}>
                        <XIcon size={12} />
                      </button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                      <input className="mcp-input" value={mcpName} onChange={e => setMcpName(e.target.value)} placeholder="Server name" />
                      <div style={{ display: "flex", gap: 6 }}>
                        <input className="mcp-input" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }} value={mcpUrl} onChange={e => setMcpUrl(e.target.value)} placeholder="https://mcp.example.com" />
                        <button className="btn-primary" onClick={handleAddMcp} disabled={isAddingMcp || !mcpName.trim() || !mcpUrl.trim()}>
                          {isAddingMcp ? "…" : "Add"}
                        </button>
                      </div>
                    </div>
                    {serverEntries.map(([id, server]) => (
                      <div key={id} className="mcp-server-row">
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600 }}>{server.name}</div>
                          <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>{server.state}</div>
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          {server.state === "authenticating" && server.auth_url && (
                            <button className="btn-primary btn-sm" onClick={() => window.open(server.auth_url as string, "oauth", "width=600,height=800")}>
                              <SignInIcon size={11} /> Auth
                            </button>
                          )}
                          <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => agent.stub.removeServer(id)}>
                            <TrashIcon size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Clear */}
              <button className="hdr-btn" onClick={clearHistory}>
                <TrashIcon size={13} />
                Clear
              </button>
            </div>
          </header>

          {/* Messages */}
          <div className="messages-scroll">
            <div className="messages-inner">

              {/* Empty state */}
              {messages.length === 0 && (
                <div className="empty-state">
                  <div className="empty-icon">
                    <GraduationCapIcon size={26} style={{ color: "var(--amber)" }} weight="bold" />
                  </div>
                  <h2 className="empty-title">
                    {activeName ? `Studying ${activeName}` : "What are you studying?"}
                  </h2>
                  <p className="empty-sub">
                    {activeName
                      ? "Ask for an explanation, request a quiz, or get your materials summarized."
                      : "Add your courses from the sidebar, upload your syllabus, then start learning."}
                  </p>
                  <div className="prompts-row">
                    {suggestedPrompts(activeName).map(p => (
                      <button
                        key={p}
                        className="prompt-chip"
                        disabled={isStreaming}
                        onClick={() => sendMessage({ role: "user", parts: [{ type: "text", text: p }] })}
                      >
                        <ArrowRightIcon size={12} />
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Message list */}
              {messages.map((message: UIMessage, index: number) => {
                const isUser = message.role === "user";
                const isLastAssistant = message.role === "assistant" && index === messages.length - 1;

                return (
                  <div key={message.id} className="message-wrap">
                    {showDebug && (
                      <pre style={{ fontSize: 10, color: "var(--muted)", background: "var(--surface)", borderRadius: 8, padding: 10, marginBottom: 8, overflow: "auto", maxHeight: 180 }}>
                        {JSON.stringify(message, null, 2)}
                      </pre>
                    )}

                    {/* Tool parts */}
                    {message.parts.filter(isToolUIPart).map(part => (
                      <ToolPartView key={part.toolCallId} part={part} addToolApprovalResponse={addToolApprovalResponse} />
                    ))}

                    {/* Reasoning */}
                    {message.parts
                      .filter(p => p.type === "reasoning" && (p as { text?: string }).text?.trim())
                      .map((part, i) => {
                        const r = part as { type: "reasoning"; text: string; state?: string };
                        return (
                          <div key={i} className="reasoning-block">
                            <details open={r.state !== "done" && isStreaming}>
                              <summary className="reasoning-summary">
                                <BrainIcon size={12} style={{ color: "#8b5cf6" }} />
                                <span>Reasoning</span>
                                <CaretDownIcon size={11} style={{ marginLeft: "auto" }} />
                              </summary>
                              <pre className="reasoning-pre">{r.text}</pre>
                            </details>
                          </div>
                        );
                      })}

                    {/* Images */}
                    {message.parts
                      .filter((p): p is Extract<typeof p, { type: "file" }> =>
                        p.type === "file" && (p as { mediaType?: string }).mediaType?.startsWith("image/") === true)
                      .map((part, i) => (
                        <div key={`img-${i}`} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 6 }}>
                          <img src={part.url} alt="Attachment" style={{ maxHeight: 220, borderRadius: 10, border: "1px solid var(--border2)", objectFit: "contain" }} />
                        </div>
                      ))}

                    {/* Text */}
                    {message.parts
                      .filter(p => p.type === "text")
                      .map((part, i) => {
                        const text = (part as { type: "text"; text: string }).text;
                        if (!text) return null;

                        if (isUser) {
                          return (
                            <div key={i} className="bubble-user">
                              <div className="bubble-user-inner">{text}</div>
                            </div>
                          );
                        }

                        return (
                          <div key={i} className="bubble-assistant">
                            <div className="bubble-assistant-inner">
                              {i === 0 && (
                                <div
                                  className="assistant-label"
                                  style={{ color: activeColor?.bg ?? "var(--amber)" }}
                                >
                                  {activeName ?? "Assistant"}
                                </div>
                              )}
                              <Streamdown
                                className="sd-theme"
                                plugins={{ code }}
                                controls={false}
                                isAnimating={isLastAssistant && isStreaming}
                              >
                                {text}
                              </Streamdown>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                );
              })}

              {/* Thinking indicator */}
              {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
                <div className="thinking">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  <span style={{ marginLeft: 2 }}>Thinking…</span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input bar */}
          <div className="input-area">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*"
              style={{ display: "none" }}
              onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
            />

            {attachments.length > 0 && (
              <div className="attachments">
                {attachments.map(att => (
                  <div key={att.id} className="att-thumb">
                    <img src={att.preview} alt={att.file.name} />
                    <button className="att-remove" onClick={() => removeAttachment(att.id)}>
                      <XIcon size={9} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="input-box">
              <button
                type="button"
                className="icon-btn"
                style={{ width: 28, height: 28, border: "none", background: "transparent", flexShrink: 0, marginBottom: 1 }}
                onClick={() => fileInputRef.current?.click()}
                disabled={!connected || isStreaming}
                aria-label="Attach image"
              >
                <PaperclipIcon size={15} />
              </button>

              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                onInput={e => { const el = e.currentTarget; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }}
                onPaste={handlePaste}
                placeholder={
                  !connected ? "Connecting…"
                    : !activeName ? "Select a course or type to get started…"
                      : `Ask anything about ${activeName}…`
                }
                disabled={!connected || isStreaming}
                rows={1}
                className="input-textarea"
              />

              {isStreaming ? (
                <button className="stop-btn" onClick={stop} aria-label="Stop">
                  <StopIcon size={15} />
                </button>
              ) : (
                <button
                  className={`send-btn ${(!input.trim() && !attachments.length) || !connected ? "send-btn--inactive" : "send-btn--active"}`}
                  onClick={send}
                  disabled={(!input.trim() && !attachments.length) || !connected}
                  aria-label="Send"
                >
                  <PaperPlaneRightIcon size={15} />
                </button>
              )}
            </div>
            <div className="input-hint">Enter to send · Shift+Enter for new line</div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <Toasty>
      <Suspense fallback={
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "var(--font-body)", color: "var(--muted)", fontSize: 13, background: "var(--bg)" }}>
          Loading…
        </div>
      }>
        <Chat />
      </Suspense>
    </Toasty>
  );
}