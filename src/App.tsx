import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
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
  saves.forEach(s => {
    const diff = Date.now() - s.time
    const label = diff < 1000 * 3600 * 24 ? '今天'
      : diff < 1000 * 3600 * 48 ? '昨天'
      : '更早'
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

  const [mainCollapsed, setMainCollapsed] = useState(false)
  const prevWidthRef = useRef<number>(900)

  const toggleCollapse = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const { LogicalSize } = await import('@tauri-apps/api/dpi')
      const w = getCurrentWindow()
      const phys = await w.outerSize()
      const factor = await w.scaleFactor()
      const logH = Math.round(phys.height / factor)
      if (!mainCollapsed) {
        prevWidthRef.current = Math.round(phys.width / factor)
        await w.setSize(new LogicalSize(340, logH)) // 272 CSS px × zoom 1.25
        setMainCollapsed(true)
      } else {
        await w.setSize(new LogicalSize(prevWidthRef.current, logH))
        setMainCollapsed(false)
      }
    } catch (e) {
      showNotif('窗口调整失败：' + String(e), 'acc')
    }
  }

  const [currentDiffs, setCurrentDiffs] = useState<DiffFile[]>([])
  const [diffsLoading, setDiffsLoading] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveDesc, setSaveDesc] = useState('')

  const [notif, setNotif] = useState<{ text: string; type: 'normal' | 'acc'; show: boolean }>({
    text: '', type: 'normal', show: false,
  })
  const notifTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Persist selected id
  useEffect(() => {
    if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId)
  }, [selectedId])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); openModal() }
      if (e.key === 'Escape') closeModal()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Focus modal input
  useEffect(() => {
    if (modalOpen) setTimeout(() => nameInputRef.current?.focus(), 100)
  }, [modalOpen])

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

  const rollback = async (id: string) => {
    const s = saves.find(x => x.id === id)
    if (!s) return
    if (!confirm(`确定要回滚到「${s.name}」吗？\n\n当前工作区的未存档修改将被覆盖。`)) return
    showNotif('正在回滚…', 'acc')
    try {
      await invoke('rollback_to', { projectPath, saveId: id })
      showNotif(`已回滚到：${s.name}（文件已恢复，可创建新存档保存当前状态）`)
    } catch (e) {
      showNotif('回滚失败：' + String(e), 'acc')
    }
  }

  // ── Welcome screen ───────────────────────────────────────────────────────

  const win = () => import('@tauri-apps/api/window').then(m => m.getCurrentWindow())

  const WinControls = () => (
    <div className="win-controls">
      <button className="win-btn" title="最小化" onClick={() => win().then(w => w.minimize())}>
        <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1.5" y="0.25" fill="currentColor"/></svg>
      </button>
      <button className="win-btn" title="最大化" onClick={() => win().then(w => w.toggleMaximize())}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x=".75" y=".75" width="8.5" height="8.5" stroke="currentColor" strokeWidth="1.2"/></svg>
      </button>
      <button className="win-btn win-close" title="关闭" onClick={() => win().then(w => w.close())}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
      </button>
    </div>
  )

  if (!projectPath) {
    return (
      <div className="app-shell">
        <div className="titlebar"><div className="titlebar-drag" /><WinControls /></div>
        <div className="welcome-screen">
          <div className="welcome-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect x="2" y="8" width="28" height="20" rx="2" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M2 12h28" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M2 8l4-4h8l2 4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="welcome-title">欢迎使用 SavePoint</div>
          <div className="welcome-sub">选择一个 git 项目文件夹开始使用</div>
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
      <div className="titlebar"><div className="titlebar-drag" /><WinControls /></div>
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
            <button className="btn btn-ghost" title="设置" onClick={() => setSelectedId('settings')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                <circle cx="12" cy="12" r="3"/>
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
                      onClick={() => setSelectedId(s.id)}
                    >
                      <div className="save-info">
                        <div className="save-title">{s.name}</div>
                        <div className="save-time">{formatTime(s.time)}</div>
                      </div>
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
          </div>
        </div>

        {/* Divider collapse button */}
        <button
          className="sidebar-collapse-btn"
          onClick={toggleCollapse}
          title={mainCollapsed ? '展开详情面板' : '收起详情面板'}
        >
          <svg width="8" height="12" viewBox="0 0 8 12" fill="none">
            {mainCollapsed
              ? <path d="M2 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              : <path d="M6 2L2 6l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            }
          </svg>
        </button>

        {/* Main panel */}
        <div className="main">
          {selectedId === 'settings' ? (
            <SettingsPanel showNotif={showNotif} projectPath={projectPath} onPickFolder={pickFolder} theme={theme} toggleTheme={toggleTheme} />
          ) : currentSave ? (
            <SaveDetail
              save={currentSave}
              diffs={currentDiffs}
              diffsLoading={diffsLoading}
              onRollback={rollback}
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
          <div className="modal-sub">将当前工作区的所有变更提交为一个 git 存档点。</div>
          <div className="modal-input-wrap">
            <label className="modal-label">存档名称</label>
            <input
              ref={nameInputRef}
              className="modal-input"
              placeholder="例如：完成了用户登录功能"
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
}

function SaveDetail({ save, diffs, diffsLoading, onRollback }: SaveDetailProps) {
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
          <button className="btn btn-accent" onClick={() => onRollback(save.id)}>↩ 回滚到此</button>
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
                  <div className="diff-row" key={i}>
                    <div className={`diff-icon diff-icon-${d.file_type === 'add' ? 'add' : d.file_type === 'del' ? 'del' : 'mod'}`}>
                      {d.file_type === 'add' ? '+' : d.file_type === 'del' ? '−' : '~'}
                    </div>
                    <div className="diff-filename">{d.file}</div>
                    <div className="diff-stats">
                      {d.add > 0 && <span className="diff-add">+{d.add}</span>}
                      {d.rem > 0 && <span className="diff-rem">-{d.rem}</span>}
                    </div>
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

// ── SettingsPanel ──────────────────────────────────────────────────────────

function SettingsPanel({
  showNotif,
  projectPath,
  onPickFolder,
  theme,
  toggleTheme,
}: {
  showNotif: (text: string, type?: 'normal' | 'acc') => void
  projectPath: string
  onPickFolder: () => void
  theme: 'dark' | 'light'
  toggleTheme: () => void
}) {
  return (
    <>
      <div className="main-header">
        <div>
          <div className="save-headline">设置</div>
          <div className="save-headline-meta">自动存档与偏好配置</div>
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
          <div className="card-header"><span className="card-title">自动存档</span></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="setting-row">
              <div>
                <div className="setting-label">启用自动存档</div>
                <div className="setting-sub">定时保存当前状态（即将推出）</div>
              </div>
              <label className="toggle">
                <input type="checkbox" onChange={e => showNotif(e.target.checked ? '自动存档已开启' : '自动存档已关闭')} />
                <div className="toggle-slider" />
              </label>
            </div>
            <div className="setting-row">
              <div className="setting-label">存档间隔</div>
              <div className="setting-control">
                <select defaultValue="30" onChange={() => showNotif('设置已保存')}>
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
            <div className="setting-row">
              <div>
                <div className="setting-label">存储后端</div>
                <div className="setting-sub">Git — 每个存档点对应一个 git commit</div>
              </div>
            </div>
            <div className="setting-row" style={{ marginTop: 8 }}>
              <div>
                <div className="setting-label">回滚方式</div>
                <div className="setting-sub">git checkout — 非破坏性，历史保留</div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </>
  )
}
