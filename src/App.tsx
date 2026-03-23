import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import './App.css'

// ── Types ──────────────────────────────────────────────────────────────────

interface SaveInfo {
  id: string
  name: string
  desc: string
  time: number   // ms
  delta: string
  cloud: boolean
}

interface DiffFile {
  file_type: 'add' | 'mod' | 'del'
  file: string
  add: number
  rem: number
}

// ── Helpers ────────────────────────────────────────────────────────────────

const PROJECT_PATH_KEY = 'savepoint_project_path'
const SELECTED_KEY = 'savepoint_selected'
const THEME_KEY = 'savepoint_theme'
const AUTO_SAVE_ENABLED_KEY = 'savepoint_autosave_enabled'
const AUTO_SAVE_INTERVAL_KEY = 'savepoint_autosave_interval'
const MAX_FILE_MB_KEY = 'savepoint_max_file_mb'
const blockedKey = (path: string) => `savepoint_blocked_${path}`

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d === 1) return '昨天'
  if (d < 7) return `${d} 天前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function groupByDate(saves: SaveInfo[]): Record<string, SaveInfo[]> {
  const groups: Record<string, SaveInfo[]> = {}
  const now = new Date()
  const todayStr = now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toDateString()
  saves.forEach(s => {
    const d = new Date(s.time).toDateString()
    const label = d === todayStr ? '今天' : d === yesterdayStr ? '昨天' : '更早'
    if (!groups[label]) groups[label] = []
    groups[label].push(s)
  })
  return groups
}

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p
}

// ── App ────────────────────────────────────────────────────────────────────

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    (localStorage.getItem(THEME_KEY) as 'dark' | 'light') || 'dark'
  )

  const toggleTheme = useCallback(() => {
    setTheme(t => {
      const next = t === 'dark' ? 'light' : 'dark'
      localStorage.setItem(THEME_KEY, next)
      document.documentElement.setAttribute('data-theme', next)
      return next
    })
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [])

  const [projectPath, setProjectPath] = useState<string>(() =>
    localStorage.getItem(PROJECT_PATH_KEY) || ''
  )
  const [saves, setSaves] = useState<SaveInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    localStorage.getItem(SELECTED_KEY) || null
  )
  const [loading, setLoading] = useState(false)

  const [autoSaveEnabled, setAutoSaveEnabled] = useState<boolean>(() =>
    localStorage.getItem(AUTO_SAVE_ENABLED_KEY) === 'true'
  )
  const [autoSaveInterval, setAutoSaveInterval] = useState<number>(() =>
    parseInt(localStorage.getItem(AUTO_SAVE_INTERVAL_KEY) || '30', 10)
  )
  const [maxFileMb, setMaxFileMb] = useState<number>(() =>
    parseInt(localStorage.getItem(MAX_FILE_MB_KEY) || '10', 10)
  )

  const [blockedFiles, setBlockedFiles] = useState<string[]>([])

  const [mainCollapsed, setMainCollapsed] = useState(false)
  const [pinned, setPinned] = useState(false)

  const togglePin = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const next = !pinned
    await getCurrentWindow().setAlwaysOnTop(next)
    setPinned(next)
  }
  const prevWidthRef = useRef<number>(900)

  const toggleCollapse = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const { LogicalSize } = await import('@tauri-apps/api/dpi')
      const w = getCurrentWindow()
      const phys = await w.innerSize()
      const factor = await w.scaleFactor()
      const logH = Math.round(phys.height / factor)
      await w.setResizable(true)
      if (!mainCollapsed) {
        prevWidthRef.current = Math.round(phys.width / factor)
        await w.setSize(new LogicalSize(340, logH))
        setMainCollapsed(true)
      } else {
        await w.setSize(new LogicalSize(prevWidthRef.current, logH))
        setMainCollapsed(false)
      }
      await w.setResizable(false)
    } catch (e) {
      showNotif('窗口调整失败：' + String(e), 'acc')
    }
  }

  const [currentDiffs, setCurrentDiffs] = useState<DiffFile[]>([])
  const [diffsLoading, setDiffsLoading] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveDesc, setSaveDesc] = useState('')

  const [updateInfo, setUpdateInfo] = useState<{ version: string; install: () => Promise<void> } | null>(null)
  const [updateInstalling, setUpdateInstalling] = useState(false)

  useEffect(() => {
    check().then(update => {
      if (update?.available) {
        setUpdateInfo({
          version: update.version,
          install: async () => {
            setUpdateInstalling(true)
            await update.downloadAndInstall()
            await relaunch()
          },
        })
      }
    }).catch(() => { /* 静默失败，不影响正常使用 */ })
  }, [])

  const [confirmModal, setConfirmModal] = useState<{ text: string; onConfirm: () => void } | null>(null)

  const [notif, setNotif] = useState<{ text: string; type: 'normal' | 'acc'; show: boolean }>({
    text: '', type: 'normal', show: false,
  })
  const notifTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Always-fresh callback ref so the interval doesn't capture stale closures
  const autoSaveCallbackRef = useRef<() => void>(() => { })

  // Persist selected id
  useEffect(() => {
    if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId)
  }, [selectedId])

  // Persist auto-save settings
  useEffect(() => {
    localStorage.setItem(AUTO_SAVE_ENABLED_KEY, String(autoSaveEnabled))
  }, [autoSaveEnabled])

  useEffect(() => {
    localStorage.setItem(AUTO_SAVE_INTERVAL_KEY, String(autoSaveInterval))
  }, [autoSaveInterval])

  useEffect(() => {
    localStorage.setItem(MAX_FILE_MB_KEY, String(maxFileMb))
  }, [maxFileMb])

  // Keep auto-save callback ref fresh (captures latest state without resetting the timer)
  autoSaveCallbackRef.current = async () => {
    if (!projectPath) return
    try {
      const newHash = await invoke<string>('auto_save', { projectPath, blockedFiles, maxFileMb })
      const result = await invoke<SaveInfo[]>('get_saves', { projectPath })
      setSaves(result)
      setSelectedId(newHash)
      showNotif('自动存档完成')
    } catch {
      // silently fail — don't interrupt the user
    }
  }

  // Auto-save timer — reset whenever enabled/interval/project changes
  useEffect(() => {
    if (autoSaveTimerRef.current) clearInterval(autoSaveTimerRef.current)
    if (!autoSaveEnabled || !projectPath) return
    autoSaveTimerRef.current = setInterval(() => {
      autoSaveCallbackRef.current()
    }, autoSaveInterval * 60 * 1000)
    return () => {
      if (autoSaveTimerRef.current) clearInterval(autoSaveTimerRef.current)
    }
  }, [autoSaveEnabled, autoSaveInterval, projectPath])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); openModal() }
      if (e.key === 'Escape') { closeModal(); setConfirmModal(null) }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Focus modal input
  useEffect(() => {
    if (modalOpen) setTimeout(() => nameInputRef.current?.focus(), 100)
  }, [modalOpen])

  const DEFAULT_BLOCKED = [
    '~$*',        // Office 临时文件
    '*.tmp',      // 通用临时文件
    '*.~*',       // 部分编辑器备份
    'Thumbs.db',  // Windows 缩略图缓存
    '.DS_Store',  // macOS 目录元数据
  ]

  // Load blocked files per project
  useEffect(() => {
    if (!projectPath) { setBlockedFiles([]); return }
    const stored = localStorage.getItem(blockedKey(projectPath))
    setBlockedFiles(stored ? JSON.parse(stored) : DEFAULT_BLOCKED)
  }, [projectPath])

  // Persist blocked files when they change
  useEffect(() => {
    if (!projectPath) return
    localStorage.setItem(blockedKey(projectPath), JSON.stringify(blockedFiles))
  }, [blockedFiles, projectPath])

  // Load saves when project path changes
  useEffect(() => {
    if (!projectPath) return
    localStorage.setItem(PROJECT_PATH_KEY, projectPath)
    loadSaves()
  }, [projectPath])

  // Load diffs when selected save changes
  useEffect(() => {
    if (!selectedId || selectedId === 'settings' || !projectPath) {
      setCurrentDiffs([])
      return
    }
    setDiffsLoading(true)
    invoke<DiffFile[]>('get_diff', { projectPath, saveId: selectedId })
      .then(setCurrentDiffs)
      .catch(() => setCurrentDiffs([]))
      .finally(() => setDiffsLoading(false))
  }, [selectedId, projectPath])

  const loadSaves = async () => {
    setLoading(true)
    try {
      const result = await invoke<SaveInfo[]>('get_saves', { projectPath })
      setSaves(result)
      const ids = result.map(s => s.id)
      if (!selectedId || !ids.includes(selectedId)) {
        setSelectedId(result[0]?.id ?? null)
      }
    } catch (e) {
      showNotif(String(e), 'acc')
    } finally {
      setLoading(false)
    }
  }

  const showNotif = useCallback((text: string, type: 'normal' | 'acc' = 'normal') => {
    setNotif({ text, type, show: true })
    if (notifTimer.current) clearTimeout(notifTimer.current)
    notifTimer.current = setTimeout(() => setNotif(n => ({ ...n, show: false })), 2400)
  }, [])

  const blockFile = useCallback((file: string) => {
    setBlockedFiles(prev => prev.includes(file) ? prev : [...prev, file])
    showNotif(`已屏蔽：${file}`)
  }, [showNotif])

  const unblockFile = useCallback((file: string) => {
    setBlockedFiles(prev => prev.filter(f => f !== file))
    showNotif(`已取消屏蔽：${file}`)
  }, [showNotif])

  const pickFolder = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: '选择项目文件夹' })
    if (selected && typeof selected === 'string') {
      setProjectPath(selected)
      setSelectedId(null)
    }
  }

  const openModal = () => setModalOpen(true)
  const closeModal = () => {
    setModalOpen(false)
    setSaveName('')
    setSaveDesc('')
  }

  const createSave = async () => {
    const name = saveName.trim() || '手动存档'
    closeModal()
    setLoading(true)
    try {
      const newHash = await invoke<string>('create_save', {
        projectPath,
        name,
        desc: saveDesc.trim(),
        blockedFiles,
        maxFileMb,
      })
      await loadSaves()
      setSelectedId(newHash)
      showNotif('存档创建成功！')
    } catch (e) {
      showNotif(String(e), 'acc')
    } finally {
      setLoading(false)
    }
  }

  const rollback = (id: string) => {
    const s = saves.find(x => x.id === id)
    if (!s) return
    setConfirmModal({
      text: `加载「${s.name}」？当前未存档的修改将被覆盖。`,
      onConfirm: async () => {
        showNotif('正在加载…', 'acc')
        try {
          await invoke('rollback_to', { projectPath, saveId: id })
          showNotif(`已加载：${s.name}`)
        } catch (e) {
          showNotif('加载失败：' + String(e), 'acc')
        }
      },
    })
  }

  const deleteSave = (id: string) => {
    const s = saves.find(x => x.id === id)
    if (!s) return
    setConfirmModal({
      text: `删除「${s.name}」？此操作不可撤销。`,
      onConfirm: async () => {
        try {
          await invoke('delete_save', { projectPath, saveId: id })
          const result = await invoke<SaveInfo[]>('get_saves', { projectPath })
          setSaves(result)
          if (selectedId === id) setSelectedId(result[0]?.id ?? null)
          showNotif('存档已删除')
        } catch (e) {
          showNotif('删除失败：' + String(e), 'acc')
        }
      },
    })
  }

  // ── Welcome screen ───────────────────────────────────────────────────────

  const win = () => import('@tauri-apps/api/window').then(m => m.getCurrentWindow())

  const WinControls = () => (
    <div className="win-controls">
      <button className="win-btn" title="最小化" onClick={() => win().then(w => w.minimize())}>
        <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1.5" y="0.25" fill="currentColor" /></svg>
      </button>

      <button className="win-btn win-close" title="关闭" onClick={() => win().then(w => w.close())}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
      </button>
    </div>
  )

  if (!projectPath) {
    return (
      <div className="app-shell">
        <div className="titlebar"><div className="titlebar-drag" /><span className="titlebar-title">Checkpoint</span><div className="titlebar-drag" /><WinControls /></div>
        <div className="welcome-screen">
          <div className="welcome-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect x="2" y="8" width="28" height="20" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M2 12h28" stroke="currentColor" strokeWidth="1.5" />
              <path d="M2 8l4-4h8l2 4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="welcome-title">欢迎使用 SavePoint</div>
          <div className="welcome-sub">选择一个项目文件夹开始使用</div>
          <button className="btn btn-accent" onClick={pickFolder}>选择项目文件夹</button>
        </div>
      </div>
    )
  }

  // ── Main app ─────────────────────────────────────────────────────────────

  const groups = groupByDate(saves)
  const currentSave = saves.find(s => s.id === selectedId)

  return (
    <div className="app-shell">
      <div className="titlebar">
        <button className={`pin-btn${pinned ? ' pinned' : ''}`} onClick={togglePin} title={pinned ? '取消置顶' : '置顶窗口'}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="17" x2="12" y2="22" />
            <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
          </svg>
        </button>
        <div className="titlebar-drag" />
        <span className="titlebar-title">Checkpoint</span>
        <div className="titlebar-drag" />
        <WinControls />
      </div>
      <div className={`app${mainCollapsed ? ' main-collapsed' : ''}`}>
        {/* Sidebar */}
        <div className="sidebar">
          <div className="sidebar-top">
            <div className="project-selector" onClick={pickFolder}>
              <div className="project-name">{basename(projectPath)}</div>
              <div className="project-sub">{projectPath}</div>
            </div>
          </div>

          <div className="sidebar-toolbar">
            <button className="btn btn-accent" onClick={openModal} disabled={loading}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              存档
            </button>
            <button className="btn btn-ghost" title="设置" onClick={async () => {
              setSelectedId('settings')
              if (mainCollapsed) await toggleCollapse()
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>

          <div className="saves-list">
            {loading && (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)', fontSize: '12px', fontFamily: 'var(--mono)' }}>
                加载中…
              </div>
            )}
            {!loading && saves.length === 0 && (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)', fontSize: '12px', fontFamily: 'var(--mono)' }}>
                还没有存档
              </div>
            )}
            {(['今天', '昨天', '更早'] as const).map(label =>
              groups[label] ? (
                <div className="date-group" key={label}>
                  <div className="date-label">{label}</div>
                  {groups[label].map((s, i) => (
                    <div
                      key={s.id}
                      className={`save-item${s.id === selectedId ? ' active' : ''}`}
                      style={{ animationDelay: `${i * 0.04}s` }}
                      onClick={async () => { setSelectedId(s.id); if (mainCollapsed) await toggleCollapse() }}
                    >
                      <div className="save-info">
                        <div className="save-title">{s.name}</div>
                        <div className="save-time">{formatTime(s.time)}</div>
                      </div>
                      <button
                        className="save-delete-btn"
                        title={saves.length === 1 ? '至少保留一个存档' : '删除此存档'}
                        disabled={saves.length === 1}
                        onClick={e => { e.stopPropagation(); deleteSave(s.id) }}
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              ) : null
            )}
          </div>

          <div className="sidebar-footer">
            <div style={{ fontSize: '12px', fontFamily: 'var(--mono)', color: 'var(--text3)' }}>
              {saves.length} 个存档 · {basename(projectPath)}
            </div>
            {autoSaveEnabled && (
              <div className="autosave-badge">
                <span className="autosave-dot" />
                每 {autoSaveInterval} 分钟自动存档
              </div>
            )}
          </div>

          {/* Divider collapse button */}
          <button
            className="sidebar-collapse-btn"
            onClick={toggleCollapse}
            title={mainCollapsed ? '展开详情面板' : '收起详情面板'}
          >
            <svg width="8" height="12" viewBox="0 0 8 12" fill="none">
              {mainCollapsed
                ? <path d="M2 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                : <path d="M6 2L2 6l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              }
            </svg>
          </button>
        </div>

        {/* Main panel */}
        <div className="main">
          {selectedId === 'settings' ? (
            <SettingsPanel
              showNotif={showNotif}
              projectPath={projectPath}
              onPickFolder={pickFolder}
              theme={theme}
              toggleTheme={toggleTheme}
              autoSaveEnabled={autoSaveEnabled}
              autoSaveInterval={autoSaveInterval}
              onAutoSaveToggle={setAutoSaveEnabled}
              onAutoSaveIntervalChange={setAutoSaveInterval}
              blockedFiles={blockedFiles}
              onBlockFile={blockFile}
              onUnblockFile={unblockFile}
              maxFileMb={maxFileMb}
              onMaxFileMbChange={setMaxFileMb}
            />
          ) : currentSave ? (
            <SaveDetail
              save={currentSave}
              diffs={currentDiffs}
              diffsLoading={diffsLoading}
              onRollback={rollback}
              blockedFiles={blockedFiles}
              onBlockFile={blockFile}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-text">还没有存档</div>
              <div className="empty-sub">点击"存档"按钮创建第一个</div>
            </div>
          )}
        </div>
      </div>

      {/* Save Modal */}
      <div
        className={`modal-overlay${modalOpen ? ' open' : ''}`}
        onClick={e => { if (e.target === e.currentTarget) closeModal() }}
      >
        <div className="modal">
          <div className="modal-title">创建新存档</div>
          <div className="modal-divider" />
          <div className="modal-input-wrap">
            <label className="modal-label">存档名称</label>
            <input
              ref={nameInputRef}
              className="modal-input"
              placeholder="存档名称"
              maxLength={60}
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createSave() }}
            />
          </div>
          <div className="modal-input-wrap">
            <label className="modal-label">备注（可选）</label>
            <textarea
              className="modal-input modal-textarea"
              placeholder="描述一下这次做了什么改动…"
              value={saveDesc}
              onChange={e => setSaveDesc(e.target.value)}
            />
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={closeModal}>取消</button>
            <button className="btn btn-accent" onClick={createSave}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              确认存档
            </button>
          </div>
        </div>
      </div>

      {/* Update Banner */}
      {updateInfo && (
        <div className="update-banner">
          <span className="update-banner-text">发现新版本 <strong>v{updateInfo.version}</strong></span>
          <button
            className="update-banner-btn"
            disabled={updateInstalling}
            onClick={updateInfo.install}
          >
            {updateInstalling ? '安装中…' : '立即更新'}
          </button>
          <button className="update-banner-dismiss" onClick={() => setUpdateInfo(null)}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      {/* Confirm Modal */}
      {confirmModal && (
        <div className="modal-overlay open" onClick={e => { if (e.target === e.currentTarget) setConfirmModal(null) }}>
          <div className="modal">
            <div className="modal-title">确认操作</div>
            <div className="modal-divider" />
            <div style={{ fontSize: '13px', color: 'var(--text2)', lineHeight: 1.6, fontFamily: 'var(--mono)' }}>
              {confirmModal.text}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setConfirmModal(null)}>取消</button>
              <button
                className="btn btn-accent"
                style={{ background: 'rgba(248,113,113,0.15)', color: 'rgba(248,113,113,0.9)', border: '1px solid rgba(248,113,113,0.2)' }}
                onClick={() => { setConfirmModal(null); confirmModal.onConfirm() }}
              >确认</button>
            </div>
          </div>
        </div>
      )}

      {/* Notification */}
      <div className={`notif${notif.show ? ' show' : ''}`}>
        <div className={`notif-dot${notif.type === 'acc' ? ' notif-dot-acc' : ''}`} />
        <span>{notif.text}</span>
      </div>
    </div>
  )
}

// ── SaveDetail ─────────────────────────────────────────────────────────────

interface SaveDetailProps {
  save: SaveInfo
  diffs: DiffFile[]
  diffsLoading: boolean
  onRollback: (id: string) => void
  blockedFiles: string[]
  onBlockFile: (file: string) => void
}

function SaveDetail({ save, diffs, diffsLoading, onRollback, blockedFiles, onBlockFile }: SaveDetailProps) {
  const totalAdd = diffs.reduce((a, d) => a + d.add, 0)
  const totalRem = diffs.reduce((a, d) => a + d.rem, 0)

  return (
    <>
      <div className="main-header">
        <div>
          <div className="save-headline">{save.name}</div>
          <div className="save-headline-meta">
            {new Date(save.time).toLocaleString('zh-CN')} · {save.delta}
          </div>
        </div>
        <div className="main-actions">
          <button className="btn btn-accent" onClick={() => onRollback(save.id)}>↩ 加载</button>
        </div>
      </div>

      <div className="main-body">
        {save.desc && (
          <div style={{ padding: '11px 14px', background: 'var(--bg2)', borderRadius: 'var(--radius)', fontSize: '12px', color: 'var(--text2)', lineHeight: 1.6, fontFamily: 'var(--mono)' }}>
            {save.desc}
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <span className="card-title">变更文件</span>
            {!diffsLoading && (
              <span style={{ fontSize: '11px', fontFamily: 'var(--mono)', color: 'var(--text2)' }}>
                {diffs.length} 个文件{' '}
                <span style={{ color: 'var(--text2)' }}>+{totalAdd}</span>{' '}
                <span style={{ color: 'var(--text3)' }}>-{totalRem}</span>
              </span>
            )}
          </div>
          <div className="card-body">
            {diffsLoading ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text3)', fontSize: '12px', fontFamily: 'var(--mono)' }}>
                加载中…
              </div>
            ) : diffs.length > 0 ? (
              <div className="diff-list">
                {diffs.map((d, i) => (
                  <div className={`diff-row${blockedFiles.includes(d.file) ? ' diff-row-blocked' : ''}`} key={i}>
                    <div className={`diff-icon diff-icon-${d.file_type === 'add' ? 'add' : d.file_type === 'del' ? 'del' : 'mod'}`}>
                      {d.file_type === 'add' ? '+' : d.file_type === 'del' ? '−' : '~'}
                    </div>
                    <div className="diff-filename">{d.file}</div>
                    <div className="diff-stats">
                      {d.add > 0 && <span className="diff-add">+{d.add}</span>}
                      {d.rem > 0 && <span className="diff-rem">-{d.rem}</span>}
                    </div>
                    {blockedFiles.includes(d.file) ? (
                      <span className="diff-blocked-tag">已屏蔽</span>
                    ) : (
                      <button
                        className="diff-block-btn"
                        title="屏蔽此文件（下次存档起不再追踪）"
                        onClick={() => onBlockFile(d.file)}
                      >屏蔽</button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text3)', fontSize: '12px', fontFamily: 'var(--mono)' }}>
                这是初始全量存档
              </div>
            )}
          </div>
        </div>

      </div>
    </>
  )
}

// ── UpdateChecker ───────────────────────────────────────────────────────────

function UpdateChecker() {
  const [status, setStatus] = useState<'idle' | 'checking' | 'latest' | 'available' | 'error'>('idle')
  const [newVersion, setNewVersion] = useState('')
  const [errMsg, setErrMsg] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installer, setInstaller] = useState<(() => Promise<void>) | null>(null)

  const checkNow = async () => {
    setStatus('checking')
    try {
      const update = await check()
      if (update?.available) {
        setNewVersion(update.version)
        setInstaller(() => async () => {
          setInstalling(true)
          await update.downloadAndInstall()
          const { relaunch } = await import('@tauri-apps/plugin-process')
          await relaunch()
        })
        setStatus('available')
      } else {
        setStatus('latest')
      }
    } catch (e) {
      setErrMsg(String(e))
      setStatus('error')
    }
  }

  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">检查更新</div>
        <div className="setting-sub" title={status === 'error' ? errMsg : undefined}>
          {status === 'idle' && '手动检查是否有新版本'}
          {status === 'checking' && '检查中…'}
          {status === 'latest' && '已是最新版本'}
          {status === 'available' && `发现新版本 v${newVersion}`}
          {status === 'error' && '检查失败，点击重试'}
        </div>
      </div>
      {status === 'available' ? (
        <button className="btn btn-ghost" disabled={installing} onClick={() => installer?.()}>
          {installing ? '安装中…' : '立即更新'}
        </button>
      ) : (
        <button className="btn btn-ghost" disabled={status === 'checking'} onClick={checkNow}>
          {status === 'checking' ? '检查中…' : '检查'}
        </button>
      )}
    </div>
  )
}
// ── SettingsPanel ──────────────────────────────────────────────────────────

function SettingsPanel({
  showNotif,
  projectPath,
  onPickFolder,
  theme,
  toggleTheme,
  autoSaveEnabled,
  autoSaveInterval,
  onAutoSaveToggle,
  onAutoSaveIntervalChange,
  blockedFiles,
  onBlockFile,
  onUnblockFile,
  maxFileMb,
  onMaxFileMbChange,
}: {
  showNotif: (text: string, type?: 'normal' | 'acc') => void
  projectPath: string
  onPickFolder: () => void
  theme: 'dark' | 'light'
  toggleTheme: () => void
  autoSaveEnabled: boolean
  autoSaveInterval: number
  onAutoSaveToggle: (enabled: boolean) => void
  onAutoSaveIntervalChange: (interval: number) => void
  blockedFiles: string[]
  onBlockFile: (file: string) => void
  onUnblockFile: (file: string) => void
  maxFileMb: number
  onMaxFileMbChange: (mb: number) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const customRef = useRef<HTMLInputElement>(null)

  const commitCustom = () => {
    const p = customInput.trim()
    if (!p) return
    onBlockFile(p)
    setCustomInput('')
    setShowCustom(false)
  }

  const pickBlocked = async (directory: boolean) => {
    setPickerOpen(false)
    const selected = await openDialog({
      multiple: true,
      directory,
      title: directory ? '选择要屏蔽的文件夹' : '选择要屏蔽的文件',
      defaultPath: projectPath,
    })
    const items = Array.isArray(selected) ? selected : selected ? [selected] : []
    const base = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
    for (const f of items) {
      const rel = f.replace(/\\/g, '/').replace(base + '/', '')
      onBlockFile(rel)
    }
  }

  return (
    <>
      <div className="main-header">
        <div>
          <div className="save-headline">设置</div>
        </div>
      </div>
      <div className="main-body">
        <div className="card">
          <div className="card-header"><span className="card-title">项目</span></div>
          <div className="card-body">
            <div className="setting-row">
              <div>
                <div className="setting-label">{projectPath}</div>
                <div className="setting-sub">当前监听路径</div>
              </div>
              <button className="btn btn-ghost" onClick={onPickFolder}>更改</button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">屏蔽文件</span>
            {blockedFiles.length > 0 && (
              <span style={{ fontSize: '11px', fontFamily: 'var(--mono)', color: 'var(--text3)' }}>
                {blockedFiles.length} 个
              </span>
            )}
          </div>
          <div className="card-body">
            <div className="setting-sub" style={{ marginBottom: 12 }}>
              屏蔽的文件不会被存档追踪，对当前项目生效
            </div>
            {blockedFiles.length > 0 && (
              <div className="blocked-list">
                {blockedFiles.map(f => (
                  <div className="blocked-row" key={f}>
                    <span className="blocked-path">{f}</span>
                    <button className="blocked-remove" onClick={() => onUnblockFile(f)} title="取消屏蔽">
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
              <div style={{ position: 'relative' }}>
                <button className="btn btn-ghost" style={{ fontSize: '12px' }} onClick={() => { setPickerOpen(o => !o); setShowCustom(false) }}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                  添加屏蔽…
                </button>
                {pickerOpen && (
                  <div className="pick-dropdown">
                    <button className="pick-option" onClick={() => pickBlocked(false)}>
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                        <rect x="1" y="3" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.3" />
                        <path d="M1 5h10" stroke="currentColor" strokeWidth="1.3" />
                      </svg>
                      选择文件
                    </button>
                    <button className="pick-option" onClick={() => pickBlocked(true)}>
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                        <path d="M1 4h4l1.5-2H11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.3" />
                      </svg>
                      选择文件夹
                    </button>
                    <div className="pick-divider" />
                    <button className="pick-option" onClick={() => { setPickerOpen(false); setShowCustom(true); setTimeout(() => customRef.current?.focus(), 50) }}>
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                        <path d="M1 6h10M7 2l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      自定义规则…
                    </button>
                  </div>
                )}
              </div>
              {showCustom && (
                <div className="custom-pattern-row">
                  <input
                    ref={customRef}
                    className="custom-pattern-input"
                    placeholder="如 *.log、env、docs/drafts"
                    value={customInput}
                    onChange={e => setCustomInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commitCustom(); if (e.key === 'Escape') { setShowCustom(false); setCustomInput('') } }}
                    spellCheck={false}
                  />
                  <button className="btn btn-ghost" style={{ fontSize: '12px', padding: '5px 10px' }} onClick={commitCustom} disabled={!customInput.trim()}>
                    确认
                  </button>
                  <button className="btn btn-ghost" style={{ fontSize: '12px', padding: '5px 10px' }} onClick={() => { setShowCustom(false); setCustomInput('') }}>
                    取消
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">文件大小上限</span></div>
          <div className="card-body">
            <div className="setting-row">
              <div>
                <div className="setting-label">单文件上限</div>
                <div className="setting-sub">超过此大小的文件将被跳过，0 表示不限制</div>
              </div>
              <div className="setting-control">
                <select
                  value={maxFileMb}
                  onChange={e => {
                    onMaxFileMbChange(parseInt(e.target.value, 10))
                    showNotif('文件大小上限已更新')
                  }}
                >
                  <option value="10">10 MB</option>
                  <option value="50">50 MB</option>
                  <option value="100">100 MB</option>
                  <option value="500">500 MB</option>
                  <option value="0">不限制</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">自动存档</span></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="setting-row">
              <div>
                <div className="setting-label">启用自动存档</div>
                <div className="setting-sub">按设定间隔自动保存当前项目状态</div>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={autoSaveEnabled}
                  onChange={e => {
                    onAutoSaveToggle(e.target.checked)
                    showNotif(e.target.checked ? '自动存档已开启' : '自动存档已关闭')
                  }}
                />
                <div className="toggle-slider" />
              </label>
            </div>
            <div className="setting-row">
              <div className="setting-label" style={{ color: autoSaveEnabled ? undefined : 'var(--text3)' }}>存档间隔</div>
              <div className="setting-control">
                <select
                  value={autoSaveInterval}
                  disabled={!autoSaveEnabled}
                  onChange={e => {
                    onAutoSaveIntervalChange(parseInt(e.target.value, 10))
                    showNotif('存档间隔已更新')
                  }}
                >
                  <option value="15">15 分钟</option>
                  <option value="30">30 分钟</option>
                  <option value="60">1 小时</option>
                  <option value="120">2 小时</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">外观</span></div>
          <div className="card-body">
            <div className="setting-row">
              <div>
                <div className="setting-label">深色模式</div>
                <div className="setting-sub">{theme === 'dark' ? '当前：深色' : '当前：浅色'}</div>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={theme === 'dark'} onChange={toggleTheme} />
                <div className="toggle-slider" />
              </label>
            </div>
          </div>
        </div>



        <div className="card">
          <div className="card-header"><span className="card-title">关于</span></div>
          <div className="card-body">
            <UpdateChecker />
          </div>
        </div>

      </div>
    </>
  )
}
