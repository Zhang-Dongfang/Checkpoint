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
  const [projectPath, setProjectPath] = useState<string>(() =>
    localStorage.getItem(PROJECT_PATH_KEY) || ''
  )
  const [saves, setSaves] = useState<SaveInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    localStorage.getItem(SELECTED_KEY) || null
  )
  const [loading, setLoading] = useState(false)

  const [currentDiffs, setCurrentDiffs] = useState<DiffFile[]>([])
  const [diffsLoading, setDiffsLoading] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveDesc, setSaveDesc] = useState('')

  const [notif, setNotif] = useState<{ text: string; type: 'normal' | 'acc'; show: boolean }>({
    text: '', type: 'normal', show: false,
  })
  const [clock, setClock] = useState(() => new Date().toLocaleTimeString('zh-CN'))

  const notifTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Persist selected id
  useEffect(() => {
    if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId)
  }, [selectedId])

  // Clock
  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString('zh-CN')), 1000)
    return () => clearInterval(t)
  }, [])

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

  if (!projectPath) {
    return (
      <div className="app-shell">
        <div className="titlebar">
          <div className="titlebar-dots">
            <div className="dot dot-r" /><div className="dot dot-y" /><div className="dot dot-g" />
          </div>
          <div className="titlebar-title">SavePoint</div>
          <div className="titlebar-badge">v0.1.0</div>
        </div>
        <div className="welcome-screen">
          <div className="welcome-icon">📂</div>
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
      {/* Titlebar */}
      <div className="titlebar">
        <div className="titlebar-dots">
          <div className="dot dot-r" /><div className="dot dot-y" /><div className="dot dot-g" />
        </div>
        <div className="titlebar-title">SavePoint</div>
        <div className="titlebar-badge">v0.1.0</div>
      </div>

      <div className="app">
        {/* Sidebar */}
        <div className="sidebar">
          <div className="sidebar-header">
            <div className="project-selector" onClick={pickFolder}>
              <div className="project-icon">⚡</div>
              <div>
                <div className="project-name">{basename(projectPath)}</div>
                <div className="project-sub">{projectPath}</div>
              </div>
              <div className="chevron">⌄</div>
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
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.4" />
                <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.93 2.93l1.06 1.06M10.01 10.01l1.06 1.06M2.93 11.07l1.06-1.06M10.01 3.99l1.06-1.06" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
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
                      <div className="save-num">
                        {String(saves.indexOf(s) + 1).padStart(2, '0')}
                      </div>
                      <div className="save-info">
                        <div className="save-title">{s.name}</div>
                        <div className="save-meta-line">
                          <span className="save-time">{formatTime(s.time)}</span>
                          <span className="tag tag-manual">手动</span>
                        </div>
                      </div>
                      <div className="save-delta">{s.delta}</div>
                    </div>
                  ))}
                </div>
              ) : null
            )}
          </div>

          <div className="sidebar-footer">
            <div style={{ fontSize: '11px', fontFamily: 'var(--mono)', color: 'var(--text3)' }}>
              {saves.length} 个存档 · {basename(projectPath)}
            </div>
          </div>
        </div>

        {/* Main panel */}
        <div className="main">
          {selectedId === 'settings' ? (
            <SettingsPanel showNotif={showNotif} projectPath={projectPath} onPickFolder={pickFolder} />
          ) : currentSave ? (
            <SaveDetail
              save={currentSave}
              saves={saves}
              diffs={currentDiffs}
              diffsLoading={diffsLoading}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRollback={rollback}
              showNotif={showNotif}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-icon">📭</div>
              <div className="empty-text">还没有存档</div>
              <div className="empty-sub">点击"存档"按钮创建第一个</div>
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="statusbar">
        <div className="status-item"><div className="status-dot" />监听中</div>
        <div className="status-item">项目：{basename(projectPath)}</div>
        <div className="status-item">{clock}</div>
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
  saves: SaveInfo[]
  diffs: DiffFile[]
  diffsLoading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onRollback: (id: string) => void
  showNotif: (text: string, type?: 'normal' | 'acc') => void
}

function SaveDetail({ save, saves, diffs, diffsLoading, selectedId, onSelect, onRollback, showNotif }: SaveDetailProps) {
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
          <div className="save-headline-meta" style={{ marginTop: 2, fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--text3)' }}>
            {save.id.slice(0, 8)}
          </div>
        </div>
        <div className="main-actions">
          <button className="btn btn-ghost" onClick={() => showNotif('正在对比差异…', 'acc')}>对比差异</button>
          <button className="btn btn-accent" onClick={() => onRollback(save.id)}>↩ 回滚到此</button>
        </div>
      </div>

      <div className="main-body">
        {save.desc && (
          <div style={{ padding: '12px 16px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '13px', color: 'var(--text2)', lineHeight: 1.6 }}>
            {save.desc}
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <span className="card-title">变更文件</span>
            {!diffsLoading && (
              <span style={{ fontSize: '11px', fontFamily: 'var(--mono)', color: 'var(--text2)' }}>
                {diffs.length} 个文件{' '}
                <span style={{ color: 'var(--green)' }}>+{totalAdd}</span>{' '}
                <span style={{ color: 'var(--red)' }}>-{totalRem}</span>
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

        <div className="card">
          <div className="card-header"><span className="card-title">存档时间线</span></div>
          <div className="card-body">
            <div className="timeline-viz">
              {[...saves].reverse().map((s, i) => {
                const isActive = s.id === selectedId
                const dotColor = isActive ? 'var(--accent)' : 'var(--text3)'
                return (
                  <div key={s.id} className={`tl-item${isActive ? ' active' : ''}`} onClick={() => onSelect(s.id)}>
                    <div className="tl-line-wrap">
                      {i > 0 && <div className="tl-connector" />}
                      <div
                        className={`tl-dot${isActive ? ' tl-dot-active' : ''}`}
                        style={{ background: dotColor, borderColor: isActive ? 'var(--accent)' : 'var(--bg3)' }}
                      />
                      {i < saves.length - 1 && <div className="tl-connector" />}
                    </div>
                    <div className="tl-label">#{String(saves.indexOf(s) + 1).padStart(2, '0')}</div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <CloudCTA showNotif={showNotif} />
      </div>
    </>
  )
}

// ── SettingsPanel ──────────────────────────────────────────────────────────

function SettingsPanel({
  showNotif,
  projectPath,
  onPickFolder,
}: {
  showNotif: (text: string, type?: 'normal' | 'acc') => void
  projectPath: string
  onPickFolder: () => void
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

        <CloudCTA showNotif={showNotif} />
      </div>
    </>
  )
}

// ── CloudCTA ───────────────────────────────────────────────────────────────

function CloudCTA({ showNotif }: { showNotif: (text: string, type?: 'normal' | 'acc') => void }) {
  return (
    <div className="cloud-cta">
      <div className="cloud-icon">☁</div>
      <div className="cloud-text">
        <div className="cloud-title">开启云存档同步</div>
        <div className="cloud-desc">跨设备访问你的所有存档，永不丢失，支持最多 365 天历史。</div>
        <div className="cloud-features">
          <div className="cloud-feat">跨设备同步</div>
          <div className="cloud-feat">365 天历史</div>
          <div className="cloud-feat">加密存储</div>
        </div>
      </div>
      <button className="btn btn-accent" style={{ flexShrink: 0 }} onClick={() => showNotif('云存档即将上线，敬请期待！', 'acc')}>
        升级 Pro
      </button>
    </div>
  )
}
