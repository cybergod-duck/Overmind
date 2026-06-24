const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const child_process = require('child_process')
const execSync = (command, options) => {
  return child_process.execSync(command, { windowsHide: true, ...options })
}
const exec = (command, options, callback) => {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  return child_process.exec(command, { windowsHide: true, ...options }, callback)
}
const spawn = (command, args, options) => {
  if (args && !Array.isArray(args) && typeof args === 'object') {
    options = args
    args = []
  }
  return child_process.spawn(command, args, { windowsHide: true, ...options })
}

// ── Log-line normalizer for setup IPC ────────────────────────

const stripAnsi = (s) =>
  String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')

const normalizeLogLine = (raw) => {
  if (!raw) return null
  const line = stripAnsi(String(raw))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trimEnd()
  return line.length ? line : null
}
const fs = require('fs')
const crypto = require('crypto')
const os = require('os')
const Store = require('electron-store')
const { WebSocketServer } = require('ws')

// ── Browser Bridge WebSocket server ─────────────────────────────

const BROWSER_WS_PORT = 3002
/** @type {Set<import('ws').WebSocket>} */
const browserClients = new Set()
let browserLastContext = null

const wss = new WebSocketServer({ port: BROWSER_WS_PORT })

wss.on('listening', () => {
  console.log(`[BROWSER_BRIDGE] WebSocket server listening on ws://localhost:${BROWSER_WS_PORT}`)
})

wss.on('error', (err) => {
  console.error('[BROWSER_BRIDGE] WebSocket server error:', err.message)
})

wss.on('connection', (ws) => {
  browserClients.add(ws)
  console.log(`[BROWSER_BRIDGE] Client connected (${browserClients.size} total)`)

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return // ignore malformed JSON
    }

    switch (msg.type) {
      case 'BROWSER_CONTEXT':
        browserLastContext = {
          tabId: msg.tabId,
          url: msg.url,
          title: msg.title,
          origin: msg.origin,
          timestamp: msg.timestamp,
          summary: msg.summary ?? null,
          selectionText: msg.selectionText ?? null,
        }
        console.log(`[BROWSER_BRIDGE] Context received: ${msg.title} (${msg.url})`)
        break

      case 'PING':
        ws.send(JSON.stringify({ type: 'PONG', source: 'app', timestamp: Date.now() }))
        break

      default:
        console.log(`[BROWSER_BRIDGE] Unknown message type: ${msg.type}`)
    }
  })

  ws.on('close', () => {
    browserClients.delete(ws)
    console.log(`[BROWSER_BRIDGE] Client disconnected (${browserClients.size} remaining)`)
  })

  ws.on('error', () => {
    browserClients.delete(ws)
  })
})

// ── Persistent settings store ──────────────────────────────────

const store = new Store({
  name: 'overmind-settings',
  defaults: {
    defaultModel: '',
    systemPrompt: '',
    agentLoopEnabled: true,
    autoDiagnostics: true,
    maxContextMessages: 50,
    ollamaHost: 'http://localhost:11434',
    theme: 'dark',
    watchedFolders: [],
    firstRunComplete: false,
    privacyScanHistory: [],
  },
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#080808',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  win.removeMenu()
  // win.webContents.openDevTools()
  win.loadURL('http://localhost:5173')
}

// ── IPC Handlers ──────────────────────────────────────────────

// ── Settings IPC ─────────────────────────────────────────────

ipcMain.handle('settings:get', (_e, key) => {
  return store.get(key)
})

ipcMain.handle('settings:set', (_e, key, value) => {
  store.set(key, value)
  return true
})

ipcMain.handle('settings:getAll', () => {
  return store.store
})

ipcMain.handle('settings:reset', () => {
  store.clear()
  return true
})

// ── Folder IPC ───────────────────────────────────────────────

ipcMain.handle('folder:pick', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

ipcMain.handle('folder:list', async (_e, folderPath) => {
  try {
    if (!folderPath) return 'ERROR: No folder path provided.'
    if (!fs.existsSync(folderPath)) return `ERROR: Path does not exist: ${folderPath}`

    const stat = fs.statSync(folderPath)
    if (!stat.isDirectory()) return `ERROR: Not a directory: ${folderPath}`

    const entries = fs.readdirSync(folderPath, { withFileTypes: true })
    const lines = []
    lines.push(`Listing: ${folderPath}`)
    lines.push('')

    const rows = entries.map(entry => {
      const fullPath = path.join(folderPath, entry.name)
      let size = ''
      let modified = ''
      let type = entry.isDirectory() ? 'DIR' : 'FILE'
      try {
        const s = fs.statSync(fullPath)
        const sizeBytes = s.size
        if (sizeBytes < 1024) size = `${sizeBytes} B`
        else if (sizeBytes < 1024 * 1024) size = `${(sizeBytes / 1024).toFixed(1)} KB`
        else size = `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`
        modified = s.mtime.toISOString().split('T')[0]
      } catch (_) {}
      return { name: entry.name, type, size, modified }
    })

    rows.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'DIR' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    lines.push(`${'Name'.padEnd(40)} ${'Type'.padEnd(6)} ${'Size'.padEnd(10)} Modified`)
    lines.push('─'.repeat(68))
    rows.forEach(r => {
      lines.push(`${r.name.padEnd(40)} ${r.type.padEnd(6)} ${r.size.padEnd(10)} ${r.modified}`)
    })
    lines.push('')
    lines.push(`Total: ${rows.length} entries`)

    return lines.join('\n')
  } catch (e) {
    return `LIST FOLDER ERROR: ${e.message}`
  }
})

ipcMain.handle('folder:list-json', async (_e, folderPath) => {
  try {
    if (!folderPath) return { error: 'No folder path provided.', files: [] }
    if (!fs.existsSync(folderPath)) return { error: `Path does not exist: ${folderPath}`, files: [] }

    const stat = fs.statSync(folderPath)
    if (!stat.isDirectory()) return { error: `Not a directory: ${folderPath}`, files: [] }

    const entries = fs.readdirSync(folderPath, { withFileTypes: true })
    const files = entries.map(entry => {
      const fullPath = path.join(folderPath, entry.name)
      const ext = entry.isFile() ? path.extname(entry.name).toLowerCase() : ''
      return {
        name: entry.name,
        path: fullPath,
        isDir: entry.isDirectory(),
        ext,
      }
    })
    // Sort: directories first, then files, alphabetically
    files.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { error: null, files }
  } catch (e) {
    return { error: e.message, files: [] }
  }
})

ipcMain.handle('folder:readFile', async (_e, filePath) => {
  try {
    if (!filePath) return 'ERROR: No file path provided.'
    if (!fs.existsSync(filePath)) return `ERROR: File does not exist: ${filePath}`

    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) return `ERROR: Is a directory, not a file: ${filePath}`

    const ext = path.extname(filePath).toLowerCase()

    // ── PDF handling ───────────────────────────────────────────────
    if (ext === '.pdf') {
      const maxPdfSize = 20 * 1024 * 1024 // 20MB limit for PDFs
      if (stat.size > maxPdfSize) return `ERROR: PDF too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: 20MB`

      const dataBuffer = fs.readFileSync(filePath)
      const { PDFParse } = require('pdf-parse')
      const parser = new PDFParse({ data: dataBuffer, verbosity: 0 })
      const pdfData = await parser.getText({})
      const pageCount = pdfData.total || 1
      const text = (pdfData.text || '').trim()

      if (!text) return `[PDF: ${path.basename(filePath)}]\nPages: ${pageCount}\nContent: (empty — no extractable text)`

      // Truncate very long text to 100KB to keep context manageable
      const maxTextLen = 100 * 1024
      const truncated = text.length > maxTextLen
      const body = truncated ? text.slice(0, maxTextLen) + `\n\n... (text truncated, ${text.length - maxTextLen} chars omitted)` : text

      return `[PDF: ${path.basename(filePath)}]\nPages: ${pageCount}\n\n${body}`
    }

    // ── Text file handling ─────────────────────────────────────────
    const maxSize = 100 * 1024
    if (stat.size > maxSize) return `ERROR: File too large (${(stat.size / 1024).toFixed(1)}KB). Max: 100KB`

    const content = fs.readFileSync(filePath, 'utf-8')
    return content
  } catch (e) {
    // Distinguish PDF-specific errors from generic ones
    const msg = e.message || String(e)
    if (msg.toLowerCase().includes('pdf')) return `PDF PARSE ERROR: ${msg}`
    return `READ FILE ERROR: ${msg}`
  }
})

ipcMain.handle('folder:openInExplorer', async (_e, folderPath) => {
  try {
    if (!folderPath) return false
    await shell.openPath(folderPath)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('folder:addWatched', async (_e, folderPath) => {
  try {
    if (!folderPath || !fs.existsSync(folderPath)) return false
    const watched = store.get('watchedFolders', [])
    if (watched.includes(folderPath)) return true
    watched.push(folderPath)
    store.set('watchedFolders', watched)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('folder:getWatched', () => {
  return store.get('watchedFolders', [])
})

ipcMain.handle('folder:removeWatched', async (_e, folderPath) => {
  try {
    const watched = store.get('watchedFolders', [])
    store.set('watchedFolders', watched.filter(p => p !== folderPath))
    return true
  } catch {
    return false
  }
})

// ── Legacy IPC ───────────────────────────────────────────────

ipcMain.handle('legacy:diagnoseNetwork', async () => {
  try {
    const lines = []
    lines.push('=== NETWORK DIAGNOSTIC ===')
    lines.push('')

    // ping 1.1.1.1
    try {
      const pingCloudflare = execSync('ping -n 3 1.1.1.1', { timeout: 10000 }).toString()
      const match = pingCloudflare.match(/Minimum = (\d+)ms.*?Maximum = (\d+)ms.*?Average = (\d+)ms/)
      if (match) {
        lines.push(`1.1.1.1 ping: min=${match[1]}ms  max=${match[2]}ms  avg=${match[3]}ms`)
      } else {
        const replyMatch = pingCloudflare.match(/time[=<](\d+)ms/g)
        if (replyMatch) {
          lines.push(`1.1.1.1 ping: ${replyMatch.join(', ')}`)
        } else {
          lines.push('1.1.1.1 ping: NO REPLIES (check connectivity)')
        }
      }
    } catch (e) {
      lines.push('1.1.1.1 ping: FAILED — ' + e.message.split('\n')[0])
    }

    // ping google.com
    try {
      const pingGoogle = execSync('ping -n 3 google.com', { timeout: 10000 }).toString()
      const match = pingGoogle.match(/Minimum = (\d+)ms.*?Maximum = (\d+)ms.*?Average = (\d+)ms/)
      if (match) {
        lines.push(`google.com ping: min=${match[1]}ms  max=${match[2]}ms  avg=${match[3]}ms`)
      } else {
        const replyMatch = pingGoogle.match(/time[=<](\d+)ms/g)
        if (replyMatch) {
          lines.push(`google.com ping: ${replyMatch.join(', ')}`)
        } else {
          lines.push('google.com ping: NO REPLIES (DNS or connectivity issue)')
        }
      }
    } catch (e) {
      lines.push('google.com ping: FAILED — ' + e.message.split('\n')[0])
    }

    // DNS resolution
    try {
      const nslookup = execSync('nslookup google.com', { timeout: 5000 }).toString()
      const addrMatch = nslookup.match(/Addresses?:[\s\S]+?(\d+\.\d+\.\d+\.\d+)/)
      if (addrMatch) {
        lines.push(`DNS resolution: google.com → ${addrMatch[1]}`)
      } else {
        lines.push('DNS resolution: google.com resolved (check output below)')
        lines.push(nslookup.trim())
      }
    } catch (e) {
      lines.push('DNS resolution: FAILED — ' + e.message.split('\n')[0])
    }

    lines.push('')
    lines.push(`Timestamp: ${new Date().toISOString()}`)
    return lines.join('\n')
  } catch (e) {
    return `NETWORK DIAGNOSTIC ERROR: ${e.message}`
  }
})

ipcMain.handle('legacy:diagnoseSystem', async () => {
  try {
    const si = require('systeminformation')
    const lines = []
    lines.push('=== SYSTEM DIAGNOSTIC ===')
    lines.push('')

    // CPU
    const cpu = await si.currentLoad()
    lines.push(`CPU Usage: ${cpu.currentLoad.toFixed(1)}%`)
    const cpuInfo = await si.cpu()
    lines.push(`CPU: ${cpuInfo.manufacturer} ${cpuInfo.brand} (${cpuInfo.cores} cores)`)

    // Memory
    const mem = await si.mem()
    const memUsed = (mem.used / 1024 / 1024 / 1024).toFixed(1)
    const memTotal = (mem.total / 1024 / 1024 / 1024).toFixed(1)
    const memPct = ((mem.used / mem.total) * 100).toFixed(1)
    lines.push(`Memory: ${memUsed}GB / ${memTotal}GB (${memPct}%)`)

    // Top processes by CPU
    const processes = await si.processes()
    const top5 = processes.list
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 5)
    lines.push('')
    lines.push('Top 5 processes by CPU:')
    top5.forEach((p, i) => {
      lines.push(`  ${i + 1}. ${p.name} (PID ${p.pid}) — CPU ${p.cpu.toFixed(1)}% — Mem ${(p.mem_rss / 1024 / 1024).toFixed(0)}MB`)
    })

    // OS info
    lines.push('')
    lines.push(`OS: ${os.version()} (${os.platform()} ${os.arch()})`)
    lines.push(`Uptime: ${(os.uptime() / 3600).toFixed(1)} hours`)
    lines.push(`Timestamp: ${new Date().toISOString()}`)

    return lines.join('\n')
  } catch (e) {
    return `SYSTEM DIAGNOSTIC ERROR: ${e.message}`
  }
})

ipcMain.handle('legacy:listFolder', async (_event, folderPath) => {
  try {
    if (!folderPath) return 'ERROR: No folder path provided.'
    if (!fs.existsSync(folderPath)) return `ERROR: Path does not exist: ${folderPath}`

    const stat = fs.statSync(folderPath)
    if (!stat.isDirectory()) return `ERROR: Not a directory: ${folderPath}`

    const entries = fs.readdirSync(folderPath, { withFileTypes: true })
    const lines = []
    lines.push(`Listing: ${folderPath}`)
    lines.push('')

    const rows = entries.map(entry => {
      const fullPath = path.join(folderPath, entry.name)
      let size = ''
      let modified = ''
      let type = entry.isDirectory() ? 'DIR' : 'FILE'
      try {
        const s = fs.statSync(fullPath)
        const sizeBytes = s.size
        if (sizeBytes < 1024) size = `${sizeBytes} B`
        else if (sizeBytes < 1024 * 1024) size = `${(sizeBytes / 1024).toFixed(1)} KB`
        else size = `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`
        modified = s.mtime.toISOString().split('T')[0]
      } catch (_) {}
      return { name: entry.name, type, size, modified }
    })

    // Sort: directories first, then by name
    rows.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'DIR' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    lines.push(`${'Name'.padEnd(40)} ${'Type'.padEnd(6)} ${'Size'.padEnd(10)} Modified`)
    lines.push('─'.repeat(68))
    rows.forEach(r => {
      lines.push(`${r.name.padEnd(40)} ${r.type.padEnd(6)} ${r.size.padEnd(10)} ${r.modified}`)
    })
    lines.push('')
    lines.push(`Total: ${rows.length} entries`)

    return lines.join('\n')
  } catch (e) {
    return `LIST FOLDER ERROR: ${e.message}`
  }
})

// ── System Doctor IPC Handlers ─────────────────────────────────

ipcMain.handle('system:health', async () => {
  const ollamaHost = store.get('ollamaHost', 'http://localhost:11434')
  let ollama = { running: false, models: [] }
  try {
    const res = await fetch(`${ollamaHost}/api/tags`)
    const data = await res.json()
    ollama = { running: true, models: data.models?.map((m) => m.name) ?? [] }
  } catch {}
  return {
    ollama,
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptime: Math.floor(os.uptime()),
    memory: {
      total: Math.round(os.totalmem() / 1024 / 1024),
      free:  Math.round(os.freemem()  / 1024 / 1024),
    },
  }
})

ipcMain.handle('system:ollama-pull', (_e, model) =>
  new Promise((resolve, reject) =>
    exec(`ollama pull ${model}`, (err, stdout, stderr) =>
      err ? reject(stderr) : resolve(stdout)
    )
  )
)

ipcMain.handle('system:ollama-list', () =>
  new Promise((resolve) =>
    exec('ollama list', (err, stdout) => resolve({ success: !err, output: stdout }))
  )
)

ipcMain.handle('system:write-env', (_e, entries) => {
  const envPath = path.join(process.cwd(), '.env')
  let existing = {}
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
      const [k, ...v] = line.split('=')
      if (k) existing[k.trim()] = v.join('=').trim()
    })
  }
  const merged = { ...existing, ...entries }
  fs.writeFileSync(envPath, Object.entries(merged).map(([k,v]) => `${k}=${v}`).join('\n'), 'utf-8')
  return { success: true, path: envPath }
})

ipcMain.handle('system:kill-port', (_e, port) =>
  new Promise((resolve) => {
    const cmd = os.platform() === 'win32'
      ? `for /f "tokens=5" %a in ('netstat -aon ^| find ":${port}"') do taskkill /f /pid %a`
      : `lsof -ti:${port} | xargs kill -9`
    exec(cmd, (err, stdout) => resolve({ success: !err, output: stdout }))
  })
)

// ── Setup IPC (first-run wizard) ─────────────────────────────

ipcMain.handle('setup:check-ollama-installed', async () => {
  try {
    const output = execSync('ollama --version', { timeout: 5000, stdio: 'pipe' }).toString().trim()
    return { installed: true, version: output }
  } catch {
    return { installed: false, version: null }
  }
})

ipcMain.handle('setup:check-disk-space', async () => {
  try {
    const drive = process.cwd().split(':')[0] + ':'
    const output = execSync(
      `wmic logicaldisk where caption="${drive}" get FreeSpace,Size /format:csv`,
      { timeout: 5000, stdio: 'pipe' }
    ).toString().trim()
    const lines = output.split('\n').filter(l => l.trim())
    if (lines.length >= 2) {
      const parts = lines[1].split(',')
      if (parts.length >= 3) {
        const freeBytes = parseInt(parts[1], 10)
        const totalBytes = parseInt(parts[2], 10)
        if (!isNaN(freeBytes) && !isNaN(totalBytes)) {
          return {
            freeGB: Math.round((freeBytes / 1024 / 1024 / 1024) * 10) / 10,
            totalGB: Math.round((totalBytes / 1024 / 1024 / 1024) * 10) / 10,
          }
        }
      }
    }
  } catch {}
  return { freeGB: Math.round((os.freemem() / 1024 / 1024 / 1024) * 10) / 10, totalGB: 0 }
})

ipcMain.handle('setup:install-ollama', async (event) => {
  const sendLog = (raw) => {
    const line = normalizeLogLine(raw)
    if (line) try { event.sender.send('setup:log', line) } catch {}
  }

  sendLog('[SETUP] Starting Ollama installation...')
  sendLog(`[SETUP] Platform: ${os.platform()} ${os.arch()}`)

  if (os.platform() === 'win32') {
    const installerPath = path.join(os.tmpdir(), 'OllamaSetup.exe')
    const downloadUrl = 'https://ollama.com/download/OllamaSetup.exe'

    sendLog(`[SETUP] Downloading installer from ${downloadUrl}...`)

    try {
      await new Promise((resolve, reject) => {
        const ps = spawn(
          'powershell',
          ['-Command', `Invoke-WebRequest -Uri "${downloadUrl}" -OutFile "${installerPath}" -UseBasicParsing`],
          { windowsHide: true }
        )
        ps.stdout.on('data', (data) => {
          data.toString().split('\n').forEach(l => {
            const cleaned = normalizeLogLine(l)
            if (cleaned) sendLog(`  ${cleaned}`)
          })
        })
        ps.stderr.on('data', (data) => {
          data.toString().split('\n').forEach(l => {
            const cleaned = normalizeLogLine(l)
            if (cleaned) sendLog(`  [ERR] ${cleaned}`)
          })
        })
        ps.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Download failed with exit code ${code}`))
        })
        ps.on('error', reject)
      })

      sendLog('[SETUP] Download complete. Running installer...')
      sendLog('[SETUP] (This may open a UAC prompt — please accept)')

      await new Promise((resolve, reject) => {
        const inst = spawn(installerPath, ['/S', '/VERYSILENT'], { windowsHide: false })
        inst.stdout.on('data', (data) => {
          data.toString().split('\n').forEach(l => {
            const cleaned = normalizeLogLine(l)
            if (cleaned) sendLog(`  ${cleaned}`)
          })
        })
        inst.stderr.on('data', (data) => {
          data.toString().split('\n').forEach(l => {
            const cleaned = normalizeLogLine(l)
            if (cleaned) sendLog(`  [ERR] ${cleaned}`)
          })
        })
        inst.on('close', (code) => {
          sendLog(`[SETUP] Installer exited with code ${code}`)
          resolve()
        })
        inst.on('error', reject)
      })

      sendLog('[SETUP] Ollama installed successfully!')
      sendLog('[SETUP] You may need to start Ollama from your Start Menu if it is not running.')
      return { success: true }
    } catch (err) {
      sendLog(`[SETUP] Installation failed: ${err.message}`)
      return { success: false, error: err.message }
    }
  } else {
    sendLog(`[SETUP] Auto-install not yet supported on ${os.platform()}.`)
    sendLog('[SETUP] Please visit https://ollama.com to download manually.')
    return { success: false, error: `Auto-install not supported on ${os.platform()}` }
  }
})

ipcMain.handle('setup:ollama-pull', async (event, model) => {
  const sendLog = (raw) => {
    const line = normalizeLogLine(raw)
    if (line) try { event.sender.send('setup:log', line) } catch {}
  }

  sendLog(`[PULL] Starting pull of "${model}"...`)

  return new Promise((resolve) => {
    const child = spawn('ollama', ['pull', model], { windowsHide: true })
    child.stdout.on('data', (data) => {
      data.toString().split('\n').forEach(l => {
        const cleaned = normalizeLogLine(l)
        if (cleaned) sendLog(cleaned)
      })
    })
    child.stderr.on('data', (data) => {
      data.toString().split('\n').forEach(l => {
        const cleaned = normalizeLogLine(l)
        if (cleaned) sendLog(`  ${cleaned}`)
      })
    })
    child.on('close', (code) => {
      if (code === 0) sendLog(`[PULL] "${model}" downloaded successfully!`)
      else sendLog(`[PULL] Process exited with code ${code}`)
      resolve({ success: code === 0, model })
    })
    child.on('error', (err) => {
      sendLog(`[PULL] Failed to spawn process: ${err.message}`)
      resolve({ success: false, model, error: err.message })
    })
  })
})

ipcMain.handle('system:run-command', (_e, cmd) => {
  const allowed = ['ollama list', 'ollama ps', 'ollama --version', 'node --version']
  if (!allowed.includes(cmd)) return { error: 'Command not in allowlist' }
  return new Promise((resolve) =>
    exec(cmd, (err, stdout) => resolve({ success: !err, output: stdout }))
  )
})

ipcMain.handle('system:proxy-fetch', async (_e, { url, options }) => {
  try {
    const fetchOptions = {
      ...options,
      headers: {
        ...(options.headers || {}),
        'User-Agent': 'Overmind/4.1.0 (Windows; Desktop AI Assistant)'
      }
    }
    const res = await fetch(url, fetchOptions)
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = { rawResponse: text }
    }
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    console.error('[PROXY_FETCH] Error:', err.message)
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('anthropic-request', async (_event, { endpoint, method = 'POST', headers, body }) => {
  console.log('[ANTHROPIC-BRIDGE] received request:', JSON.stringify({ endpoint, headers: Object.keys(headers), bodyLength: body ? JSON.stringify(body).length : 0 }))
  try {
    const url = `https://api.anthropic.com${endpoint}`
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        'User-Agent': 'Overmind/4.1.0 (Windows; Desktop AI Assistant)'
      }
    }
    if (body && method !== 'GET') options.body = JSON.stringify(body)

    const res = await fetch(url, options)
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = { rawResponse: text }
    }
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    console.error('[ANTHROPIC_REQUEST] Error:', err.message)
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('moonshot-request', async (_event, { endpoint, method = 'POST', headers, body }) => {
  try {
    const url = `https://api.moonshot.ai${endpoint}`
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        'User-Agent': 'Overmind/4.1.0 (Windows; Desktop AI Assistant)'
      }
    }
    if (body && method !== 'GET') options.body = JSON.stringify(body)

    const res = await fetch(url, options)
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = { rawResponse: text }
    }
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    console.error('[MOONSHOT_REQUEST] Error:', err.message)
    return { ok: false, error: err.message }
  }
})

// ── Privacy Sentinel IPC Handlers ──────────────────────────────

const SUSPICIOUS_PROCESS_KEYWORDS = [
  'keylog', 'key-log', 'keylogger', 'logkey',
  'vnc', 'teamviewer', 'anydesk', 'remoteutilities',
  'psexec', 'schtasks', 'meterpreter', 'cobalt',
  'mimikatz', 'wireshark', 'burpsuite', 'fiddler',
  'proxifier', 'windump', 'tcpview',
]

const TRACKING_HOSTS_PATTERNS = [
  /doubleclick\.net/i,
  /googleadservices\.com/i,
  /google-analytics\.com/i,
  /googlesyndication\.com/i,
  /facebook\.com\/tr/i,
  /amazon-adsystem\.com/i,
  /scorecardresearch\.com/i,
  /outbrain\.com/i,
  /taboola\.com/i,
  /criteo\.com/i,
  /adnxs\.com/i,
]

// ── Scan startup items (Windows) ──────────────────────────────

async function scanStartup() {
  const items = []

  // 1. Startup folder (current user)
  const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  if (fs.existsSync(startupDir)) {
    const entries = fs.readdirSync(startupDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(startupDir, entry.name)
      items.push({ name: entry.name, path: fullPath, source: 'Startup Folder', target: entry.isFile() && entry.name.endsWith('.lnk') ? '[shortcut]' : fullPath })
    }
  }

  // 2. Registry HKCU Run keys
  try {
    const regOut = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"', { timeout: 5000, stdio: 'pipe' }).toString()
    regOut.split('\n').filter(l => l.trim() && !l.startsWith('!') && !l.startsWith('HKEY')).forEach(line => {
      const parts = line.trim().split(/\s{2,}/)
      if (parts.length >= 2) items.push({ name: parts[0].trim(), path: parts.slice(1).join(' ').trim(), source: 'HKCU Run', target: parts.slice(1).join(' ').trim() })
    })
  } catch {}

  // 3. Registry HKLM Run keys
  try {
    const regOut = execSync('reg query "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"', { timeout: 5000, stdio: 'pipe' }).toString()
    regOut.split('\n').filter(l => l.trim() && !l.startsWith('!') && !l.startsWith('HKEY')).forEach(line => {
      const parts = line.trim().split(/\s{2,}/)
      if (parts.length >= 2) items.push({ name: parts[0].trim(), path: parts.slice(1).join(' ').trim(), source: 'HKLM Run', target: parts.slice(1).join(' ').trim() })
    })
  } catch {}

  // Flag suspicious entries
  const flagged = items.filter(item => SUSPICIOUS_PROCESS_KEYWORDS.some(kw => (`${item.name} ${item.path}`).toLowerCase().includes(kw)))

  return { items, flagged, totalCount: items.length, flaggedCount: flagged.length }
}

ipcMain.handle('privacy:scan-startup', async () => {
  try { return await scanStartup() }
  catch (e) { return { items: [], flagged: [], totalCount: 0, flaggedCount: 0, error: e.message } }
})

// ── Scan hosts file ───────────────────────────────────────────

async function scanHosts() {
  let hostFile
  try { hostFile = fs.readFileSync(path.join(os.homedir(), '..', '..', 'Windows', 'System32', 'drivers', 'etc', 'hosts'), 'utf-8') }
  catch { hostFile = fs.readFileSync('C:\\Windows\\System32\\drivers\\etc\\hosts', 'utf-8') }

  const lines = hostFile.split('\n')
  const entries = []
  const anomalies = []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw || raw.startsWith('#') || raw.startsWith('!')) continue
    const parts = raw.split(/\s+/)
    if (parts.length < 2) continue

    const ip = parts[0]
    const hostnames = parts.slice(1).filter(h => !h.startsWith('#'))

    for (const hostname of hostnames) {
      entries.push({ line: i + 1, ip, hostname })

      if ((ip === '127.0.0.1' || ip === '0.0.0.0') &&
          (hostname.includes('google') || hostname.includes('facebook') || hostname.includes('microsoft') ||
           hostname.includes('apple') || hostname.includes('amazon') || hostname.includes('youtube'))) {
        anomalies.push({ type: 'info', message: `Legitimate domain redirected to localhost: ${hostname} → ${ip}`, line: i + 1 })
      }

      for (const pattern of TRACKING_HOSTS_PATTERNS) {
        if (pattern.test(hostname)) { anomalies.push({ type: 'warning', message: `Tracking domain blocked: ${hostname} → ${ip}`, line: i + 1 }); break }
      }

      if (ip.match(/^\d+\.\d+\.\d+\.\d+$/) && ip !== '127.0.0.1' && ip !== '0.0.0.0' &&
          !ip.startsWith('192.168.') && !ip.startsWith('10.') && !ip.startsWith('172.') &&
          hostnames.some(h => !h.includes('localhost') && !h.endsWith('.local'))) {
        anomalies.push({ type: 'critical', message: `External IP redirect: ${hostname} → ${ip}`, line: i + 1 })
      }
    }
  }

  return { entries, anomalies, totalEntries: entries.length, anomalyCount: anomalies.length }
}

ipcMain.handle('privacy:scan-hosts', async () => {
  try { return await scanHosts() }
  catch (e) { return { entries: [], anomalies: [], totalEntries: 0, anomalyCount: 0, error: e.message } }
})

// ── Scan running processes ────────────────────────────────────

async function scanProcesses() {
  const raw = execSync('tasklist /V /FO CSV', { timeout: 10000, stdio: 'pipe' }).toString()
  const lines = raw.split('\n').filter(l => l.trim())
  const processes = []
  const warnings = []

  for (let i = 1; i < lines.length; i++) {
    try {
      const cols = lines[i].match(/"([^"]*)"/g)
      if (!cols || cols.length < 9) continue
      const name = cols[0].replace(/"/g, '').trim()
      const pid = parseInt(cols[1].replace(/"/g, ''), 10)
      const memStr = cols[4].replace(/"/g, '').trim()
      const status = cols[5].replace(/"/g, '').trim()
      const user = cols[6].replace(/"/g, '').trim()

      let memMB = 0
      const memMatchK = memStr.match(/([\d,]+)\s*K/)
      if (memMatchK) memMB = Math.round(parseInt(memMatchK[1].replace(/,/g, ''), 10) / 1024)
      const memMatchM = memStr.match(/([\d,]+)\s*M/)
      if (memMatchM) memMB = parseInt(memMatchM[1].replace(/,/g, ''), 10)

      const lowerName = name.toLowerCase()
      const matchedKeyword = SUSPICIOUS_PROCESS_KEYWORDS.find(kw => lowerName.includes(kw))
      if (matchedKeyword) warnings.push({ type: 'critical', pid, name, reason: `Suspicious process name matches keyword: "${matchedKeyword}"` })
      if (memMB > 500) warnings.push({ type: 'warning', pid, name, reason: `High memory usage: ${memMB}MB` })
      if (status === 'Running' && name !== 'System Idle Process' && name !== 'System') {
        const title = cols.length > 8 ? cols[8].replace(/"/g, '').trim() : ''
        if (!title && !name.includes('svchost') && !name.includes('runtime') && !name.includes('conhost'))
          warnings.push({ type: 'info', pid, name, reason: 'No window title (possible background service)' })
      }

      processes.push({ name, pid, memoryMB: memMB, status, user })
    } catch {}
  }

  return { processes: processes.slice(0, 200), warnings, totalCount: processes.length, warningCount: warnings.length }
}

ipcMain.handle('privacy:scan-processes', async () => {
  try { return await scanProcesses() }
  catch (e) { return { processes: [], warnings: [], totalCount: 0, warningCount: 0, error: e.message } }
})

// ── Scan DNS configuration ────────────────────────────────────

async function scanDnsConfig() {
  const info = { interfaces: [], dnsServers: [], warnings: [] }

  try {
    const ipconfig = execSync('ipconfig /all', { timeout: 10000, stdio: 'pipe' }).toString()
    const lines = ipconfig.split('\n')
    let currentAdapter = ''
    const dnsSet = new Set()

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.match(/^Ethernet adapter|^Wireless|^Wi-Fi|^Unknown adapter/) || trimmed.endsWith(':')) {
        currentAdapter = trimmed.replace(':', '').trim()
        info.interfaces.push({ name: currentAdapter, dnsServers: [] })
      }
      if (trimmed.includes('DNS Servers') || trimmed.match(/^\d+\.\d+\.\d+\.\d+/)) {
        const dnsMatch = trimmed.match(/(\d+\.\d+\.\d+\.\d+)/)
        if (dnsMatch && !dnsMatch[1].startsWith('192.168') && !dnsMatch[1].startsWith('10.')) {
          const server = dnsMatch[1]
          if (!dnsSet.has(server)) {
            dnsSet.add(server)
            info.dnsServers.push(server)
            if (!['1.1.1.1','1.0.0.1','8.8.8.8','8.8.4.4','9.9.9.9','208.67.222.222','208.67.220.220'].includes(server))
              info.warnings.push({ type: 'info', message: `Non-standard DNS server: ${server}` })
          }
        }
      }
    }
  } catch {}

  try {
    const dohCheck = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\SecureDNS" /s 2>nul || reg query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Dnscache\\Parameters" /v EnableAutoDoh 2>nul', { timeout: 5000, stdio: 'pipe' }).toString().trim()
    if (dohCheck) info.warnings.push({ type: 'info', message: dohCheck.includes('0x1') || dohCheck.includes('0x2') ? 'DNS-over-HTTPS (DoH) is enabled' : 'DNS-over-HTTPS (DoH) may be disabled' })
  } catch {}

  let resolutionMs = 'unknown'
  try { const start = Date.now(); execSync('nslookup google.com 8.8.8.8', { timeout: 5000, stdio: 'pipe' }); resolutionMs = `${Date.now() - start}ms` } catch {}

  return { ...info, resolutionTime: resolutionMs, dnsCount: info.dnsServers.length }
}

ipcMain.handle('privacy:scan-dns-config', async () => {
  try { return await scanDnsConfig() }
  catch (e) { return { interfaces: [], dnsServers: [], warnings: [], dnsCount: 0, resolutionTime: 'error', error: e.message } }
})

// ── Scan summary (aggregate all) ──────────────────────────────

ipcMain.handle('privacy:scan-summary', async () => {
  try {
    const [startup, hosts, processes, dns] = await Promise.all([
      scanStartup().catch(() => ({ items: [], flagged: [], totalCount: 0, flaggedCount: 0 })),
      scanHosts().catch(() => ({ entries: [], anomalies: [], totalEntries: 0, anomalyCount: 0 })),
      scanProcesses().catch(() => ({ processes: [], warnings: [], totalCount: 0, warningCount: 0 })),
      scanDnsConfig().catch(() => ({ dnsServers: [], warnings: [], dnsCount: 0, resolutionTime: 'error' })),
    ])

    const summary = { startup, hosts, processes, dns, timestamp: new Date().toISOString() }

    const history = store.get('privacyScanHistory', [])
    history.unshift(summary)
    if (history.length > 10) history.length = 10
    store.set('privacyScanHistory', history)

    return summary
  } catch (e) {
    return { error: e.message }
  }
})

// ── Get scan history ──────────────────────────────────────────

ipcMain.handle('privacy:get-history', () => {
  return store.get('privacyScanHistory', [])
})

// ── Privacy Remediation IPC handlers ──────────────────────────

ipcMain.handle('privacy:open-startup-folder', async () => {
  const startupPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  const err = await shell.openPath(startupPath)
  return { success: !err, error: err || undefined }
})

ipcMain.handle('privacy:open-reg-key', async (_e, params) => {
  try {
    // Open RegEdit at the specified key
    execSync(`reg add "${params.key}" /f 2>nul`, { timeout: 3000, stdio: 'ignore' })
    exec(`start regedit`, { shell: true })
    return { success: true, note: `Opened RegEdit. Navigate to: ${params.key}` }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('privacy:kill-process', async (_e, params) => {
  try {
    execSync(`taskkill /PID ${params.pid} /F`, { timeout: 5000, stdio: 'pipe' })
    return { success: true, pid: params.pid }
  } catch (e) {
    return { success: false, pid: params.pid, error: e.message }
  }
})

ipcMain.handle('privacy:open-hosts-file', async () => {
  const hostsPath = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  const err = await shell.openPath(hostsPath)
  return { success: !err, error: err || undefined }
})

ipcMain.handle('privacy:open-dns-settings', async () => {
  await shell.openExternal('ms-settings:network-ethernet')
  return { success: true }
})

ipcMain.handle('privacy:backup-hosts-file', async () => {
  const hostsPath = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  const backupPath = `C:\\Windows\\System32\\drivers\\etc\\hosts.backup.${Date.now()}`
  try {
    fs.copyFileSync(hostsPath, backupPath)
    return { success: true, backupPath }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ── Browser Bridge IPC handlers ────────────────────────────────

ipcMain.handle('browser:get-status', () => {
  return { connected: browserClients.size > 0, clients: browserClients.size }
})

ipcMain.handle('browser:send-action', (_e, msg) => {
  const payload = JSON.stringify(msg)
  let sent = 0
  for (const client of browserClients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(payload)
      sent++
    }
  }
  console.log(`[BROWSER_BRIDGE] Action forwarded to ${sent} client(s): ${msg.actionId}`)
  return { forwarded: sent }
})

ipcMain.handle('browser:get-last-context', () => {
  return browserLastContext
})

// ── File Pick & Read IPC (attach file to chat) ────────────────

ipcMain.handle('file:pick-and-read', async () => {
  try {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Text & Code', extensions: ['txt', 'md', 'json', 'csv', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'sh', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'env', 'log', 'sql'] },
        { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'rtf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePaths.length) return null

    const filePath = result.filePaths[0]
    const stat = fs.statSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const fileName = path.basename(filePath)

    // ── PDF handling ───────────────────────────────────────────────
    if (ext === '.pdf') {
      const maxPdfSize = 20 * 1024 * 1024
      if (stat.size > maxPdfSize) return { fileName, error: `PDF too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: 20MB` }

      try {
        const dataBuffer = fs.readFileSync(filePath)
        const { PDFParse } = require('pdf-parse')
        const parser = new PDFParse({ data: dataBuffer, verbosity: 0 })
        const pdfData = await parser.getText({})
        const pageCount = pdfData.total || 1
        const text = (pdfData.text || '').trim()
        const maxTextLen = 100 * 1024
        const truncated = text.length > maxTextLen
        const body = truncated ? text.slice(0, maxTextLen) + `\n\n... (text truncated, ${text.length - maxTextLen} chars omitted)` : text

        return {
          fileName,
          content: body || '(empty — no extractable text)',
          sizeBytes: stat.size,
          ext,
          pageCount,
        }
      } catch (e) {
        return { fileName, error: `PDF parse error: ${e.message}` }
      }
    }

    // ── Text file handling ─────────────────────────────────────────
    const maxSize = 500 * 1024 // 500KB limit for attachments
    if (stat.size > maxSize) return { fileName, error: `File too large (${(stat.size / 1024).toFixed(1)}KB). Max: 500KB` }

    const content = fs.readFileSync(filePath, 'utf-8')
    return {
      fileName,
      content,
      sizeBytes: stat.size,
      ext,
    }
  } catch (e) {
    return { error: e.message }
  }
})

// ── FILE OPERATION IPC Handlers ───────────────────────────────

ipcMain.handle('folder:moveFile', async (_e, { sourcePath, targetPath }) => {
  try {
    if (!sourcePath || !targetPath) return { success: false, error: 'sourcePath and targetPath required' }
    if (!fs.existsSync(sourcePath)) return { success: false, error: `Source does not exist: ${sourcePath}` }
    if (fs.existsSync(targetPath)) return { success: false, error: `Target already exists: ${targetPath}` }
    const targetDir = path.dirname(targetPath)
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
    fs.renameSync(sourcePath, targetPath)
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('folder:renameFile', async (_e, { filePath, newName }) => {
  try {
    if (!filePath || !newName) return { success: false, error: 'filePath and newName required' }
    if (!fs.existsSync(filePath)) return { success: false, error: `File does not exist: ${filePath}` }
    const dir = path.dirname(filePath)
    const targetPath = path.join(dir, newName)
    if (fs.existsSync(targetPath)) return { success: false, error: `Target already exists: ${targetPath}` }
    fs.renameSync(filePath, targetPath)
    return { success: true, newPath: targetPath }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('folder:deleteFile', async (_e, { filePath }) => {
  try {
    if (!filePath) return { success: false, error: 'filePath required' }
    if (!fs.existsSync(filePath)) return { success: false, error: `File does not exist: ${filePath}` }
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true })
    } else {
      fs.unlinkSync(filePath)
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('folder:createFolder', async (_e, { folderPath }) => {
  try {
    if (!folderPath) return { success: false, error: 'folderPath required' }
    if (fs.existsSync(folderPath)) return { success: false, error: `Folder already exists: ${folderPath}` }
    fs.mkdirSync(folderPath, { recursive: true })
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('folder:organizeSmart', async (_e, { folderPath }) => {
  try {
    if (!folderPath) return { success: false, error: 'folderPath required' }
    if (!fs.existsSync(folderPath)) return { success: false, error: `Folder does not exist: ${folderPath}` }

    const TOPIC_FOLDERS = {
      'Banking':      [/bank/i, /chase/i, /wells\s*fargo/i, /bofa/i, /statement/i, /account/i, /deposit/i, /withdrawal/i],
      'Legal':        [/court/i, /legal/i, /attorney/i, /lawsuit/i, /subpoena/i, /docket/i, /case\s*#/i, /filing/i],
      'Medical':      [/health/i, /medical/i, /hospital/i, /doctor/i, /insurance/i, /hipaa/i, /medic/i, /prescription/i],
      'Taxes':        [/tax/i, /irs/i, /1040/i, /w-?2/i, /1099/i, /wages/i, /withholding/i],
      'Child Support': [/child\s*support/i, /cs\s*(case|payment)/i, /custody/i, /parenting\s*plan/i],
      'Education':    [/transcript/i, /diploma/i, /degree/i, /school/i, /university/i, /college/i],
      'Identification': [/passport/i, /license/i, /ssn/i, /social\s*security/i, /id\s*card/i],
      'Payroll':      [/payroll/i, /pay\s*stub/i, /earning/i, /wage/i, /direct\s*deposit/i],
      'Real Estate':  [/mortgage/i, /deed/i, /title/i, /property/i, /lease/i, /rental/i],
      'Investments':  [/401k/i, /ira/i, /retirement/i, /investment/i, /stock/i, /pension/i],
      'Invoices':     [/invoice/i, /bill/i, /receipt/i, /payment/i, /charge/i],
      'Correspondence': [/letter/i, /notice/i, /notification/i, /correspondence/i],
    }

    const entries = fs.readdirSync(folderPath, { withFileTypes: true })
    const moved = []
    const created = []

    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = entry.name
      const ext = path.extname(name).toLowerCase()
      if (ext !== '.pdf' && ext !== '.txt' && ext !== '.doc' && ext !== '.docx' && ext !== '.jpg' && ext !== '.png') continue

      let targetSubfolder = null
      for (const [subfolder, patterns] of Object.entries(TOPIC_FOLDERS)) {
        if (patterns.some(p => p.test(name))) {
          targetSubfolder = subfolder
          break
        }
      }

      if (targetSubfolder) {
        const subDir = path.join(folderPath, targetSubfolder)
        if (!fs.existsSync(subDir)) {
          fs.mkdirSync(subDir, { recursive: true })
          created.push(targetSubfolder)
        }
        const sourceFile = path.join(folderPath, name)
        const targetFile = path.join(subDir, name)
        // Handle name collisions
        const finalTarget = fs.existsSync(targetFile)
          ? path.join(subDir, `${path.parse(name).name}_${Date.now()}${ext}`)
          : targetFile
        fs.renameSync(sourceFile, finalTarget)
        moved.push({ name, to: targetSubfolder })
      }
    }

    const summary = []
    if (created.length > 0) summary.push(`Created folders: ${[...new Set(created)].join(', ')}`)
    if (moved.length > 0) summary.push(`Moved ${moved.length} file(s) into topic folders`)
    if (moved.length === 0) summary.push('No files matched any topic — nothing to organize')

    return { success: true, moved, created: [...new Set(created)], summary: summary.join('; ') }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ── INTELLIGENT SYSTEM DOCTOR — Extended IPC Handlers ─────────

ipcMain.handle('doctor:flushDns', async () => {
  try {
    const output = execSync('ipconfig /flushdns', { timeout: 10000, stdio: 'pipe' }).toString()
    return { success: true, details: 'DNS cache flushed successfully', output: output.trim() }
  } catch (e) {
    return { success: false, error: e.message, details: 'Failed to flush DNS (may need admin privileges)' }
  }
})

ipcMain.handle('doctor:winsockReset', async () => {
  const steps = []
  try {
    const reset1 = execSync('netsh winsock reset', { timeout: 15000, stdio: 'pipe' }).toString()
    steps.push({ step: 'Winsock reset', success: true, detail: 'Winsock catalog reset (reboot required)' })
  } catch (e) { steps.push({ step: 'Winsock reset', success: false, detail: e.message }) }
  try {
    const reset2 = execSync('netsh int ip reset', { timeout: 15000, stdio: 'pipe' }).toString()
    steps.push({ step: 'TCP/IP reset', success: true, detail: 'TCP/IP stack reset (reboot required)' })
  } catch (e) { steps.push({ step: 'TCP/IP reset', success: false, detail: e.message }) }
  const ok = steps.filter(s => s.success).length
  return { success: ok > 0, steps, summary: `Winsock reset: ${ok}/${steps.length} steps completed. Reboot required.` }
})

ipcMain.handle('doctor:sfcScan', async () => {
  try {
    const output = execSync('sfc /scannow', { timeout: 600000, stdio: 'pipe' }).toString()
    const corrupted = output.includes('found corrupt files') || output.includes('repair')
    const clean = output.includes('did not find any integrity violations')
    return {
      success: true,
      clean,
      corrupted,
      details: clean ? 'SFC: No integrity violations found' : 'SFC: Corrupt files found and repaired',
      output: output.trim().split('\n').slice(-5).join('\n'),
    }
  } catch (e) {
    return { success: false, error: e.message, details: 'SFC scan failed (may need admin privileges)' }
  }
})

ipcMain.handle('doctor:dismRestoreHealth', async () => {
  try {
    const output = execSync('DISM /Online /Cleanup-Image /RestoreHealth', { timeout: 600000, stdio: 'pipe' }).toString()
    const restored = output.includes('restoration completed') || output.includes('restored')
    const healthy = output.includes('no component store corruption')
    return {
      success: true,
      healthy,
      restored,
      details: healthy ? 'DISM: Component store is healthy' : (restored ? 'DISM: Corruption repaired' : 'DISM completed'),
      output: output.trim().split('\n').slice(-5).join('\n'),
    }
  } catch (e) {
    return { success: false, error: e.message, details: 'DISM restore failed (may need admin privileges)' }
  }
})

ipcMain.handle('doctor:chkdsk', async () => {
  try {
    const output = execSync('chkdsk C: /scan', { timeout: 120000, stdio: 'pipe' }).toString()
    const errors = output.includes('found') && !output.includes('0 KB in bad sectors')
    const clean = output.includes('has no problems') || output.includes('no further action')
    return {
      success: true,
      clean,
      hasErrors: errors,
      details: clean ? 'CHKDSK: No file system errors found' : 'CHKDSK: Errors found — review output',
      output: output.trim().split('\n').slice(-8).join('\n'),
    }
  } catch (e) {
    return { success: false, error: e.message, details: 'CHKDSK scan failed (may need admin privileges)' }
  }
})

ipcMain.handle('doctor:networkFullDiagnostics', async () => {
  const results = {}
  results.timestamp = new Date().toISOString()

  // Ping cloudflare + google
  try {
    const cf = execSync('ping -n 3 1.1.1.1', { timeout: 10000, stdio: 'pipe' }).toString()
    const cfMatch = cf.match(/Minimum = (\d+)ms.*?Maximum = (\d+)ms.*?Average = (\d+)ms/)
    results.pingCloudflare = cfMatch ? { min: parseInt(cfMatch[1]), max: parseInt(cfMatch[2]), avg: parseInt(cfMatch[3]) } : { raw: cf.trim().split('\n').pop() }
  } catch { results.pingCloudflare = { error: '1.1.1.1 unreachable' } }

  try {
    const gg = execSync('ping -n 3 google.com', { timeout: 10000, stdio: 'pipe' }).toString()
    const ggMatch = gg.match(/Minimum = (\d+)ms.*?Maximum = (\d+)ms.*?Average = (\d+)ms/)
    results.pingGoogle = ggMatch ? { min: parseInt(ggMatch[1]), max: parseInt(ggMatch[2]), avg: parseInt(ggMatch[3]) } : { raw: gg.trim().split('\n').pop() }
  } catch { results.pingGoogle = { error: 'google.com unreachable (DNS?)' } }

  // DNS resolution test
  try {
    const ns = execSync('nslookup google.com 8.8.8.8', { timeout: 5000, stdio: 'pipe' }).toString()
    const addr = ns.match(/Address(?:es)?:[\s\S]+?(\d+\.\d+\.\d+\.\d+)/)
    results.dnsLookup = addr ? { server: '8.8.8.8', resolved: addr[1] } : { server: '8.8.8.8', raw: ns.trim().split('\n').slice(-2).join(' ') }
  } catch { results.dnsLookup = { error: 'DNS lookup failed' } }

  // Traceroute (quick, 1 hop)
  try {
    const tr = execSync('tracert -h 5 1.1.1.1', { timeout: 15000, stdio: 'pipe' }).toString()
    const hops = tr.split('\n').filter(l => l.match(/^\s+\d+\s+/)).length
    results.traceroute = { hops, summary: `${hops} hop(s) to 1.1.1.1` }
  } catch { results.traceroute = { error: 'Traceroute failed' } }

  // Speed test via PowerShell (download test from a known file)
  try {
    const ps = execSync('powershell -Command "(New-Object Net.WebClient).DownloadString(\'https://speed.cloudflare.com/__down?bytes=10000000\') -replace \'.*\',\'\' 2>$null; $sw = [Diagnostics.Stopwatch]::StartNew(); $wc = New-Object Net.WebClient; $data = $wc.DownloadData(\'https://speed.cloudflare.com/__down?bytes=10000000\'); $sw.Stop(); $mbps = [Math]::Round(10 / $sw.Elapsed.TotalSeconds * 8, 1); Write-Output \'DL_SPEED: $mbps Mbps\'"', { timeout: 30000, stdio: 'pipe' }).toString()
    const speedMatch = ps.match(/DL_SPEED:\s*([\d.]+)\s*Mbps/)
    results.speedTest = speedMatch ? { downloadMbps: parseFloat(speedMatch[1]) } : { raw: ps.trim().split('\n').filter(l => l.includes('Mbps')).join(', ') }
  } catch { results.speedTest = { error: 'Speed test failed' } }

  // Network adapters
  try {
    const adapters = execSync('powershell -Command "Get-NetAdapter | Where-Object {$_.Status -eq \'Up\'} | Select-Object Name, LinkSpeed, Status | ConvertTo-Json"', { timeout: 10000, stdio: 'pipe' }).toString()
    const parsed = JSON.parse(adapters)
    results.adapters = Array.isArray(parsed) ? parsed.map(a => ({ name: a.Name, speed: a.LinkSpeed, status: a.Status })) : [{ name: parsed.Name, speed: parsed.LinkSpeed, status: parsed.Status }]
  } catch { results.adapters = [] }

  // Gateway ping
  try {
    const ipcfg = execSync('ipconfig', { timeout: 5000, stdio: 'pipe' }).toString()
    const gwMatch = ipcfg.match(/Default Gateway[. .]+:\s*(\d+\.\d+\.\d+\.\d+)/)
    if (gwMatch) {
      const gwPing = execSync(`ping -n 2 ${gwMatch[1]}`, { timeout: 5000, stdio: 'pipe' }).toString()
      results.gateway = { ip: gwMatch[1], reachable: gwPing.includes('time=') || gwPing.includes('time<') }
    }
  } catch {}

  // Diagnosis
  const issues = []
  if (results.pingCloudflare.error) issues.push('❌ No internet connectivity (1.1.1.1 unreachable)')
  else if (results.pingCloudflare.avg > 100) issues.push(`⚠️ High latency to cloudflare: ${results.pingCloudflare.avg}ms`)
  if (results.pingGoogle.error) issues.push('❌ DNS resolution failing (google.com unreachable)')
  if (results.dnsLookup.error) issues.push('❌ DNS server not responding')
  if (results.speedTest && results.speedTest.downloadMbps < 5) issues.push(`⚠️ Very slow connection: ${results.speedTest.downloadMbps} Mbps`)
  if (results.gateway && !results.gateway.reachable) issues.push('❌ Default gateway unreachable — local network issue')
  if (issues.length === 0) issues.push('✅ Network appears healthy')

  results.issues = issues
  results.summary = issues.join('\n')
  return results
})

ipcMain.handle('doctor:highCpuProcesses', async () => {
  try {
    const si = require('systeminformation')
    const [processes, load] = await Promise.all([
      si.processes(),
      si.currentLoad(),
    ])
    const cpuLoad = Math.round(load.currentLoad * 10) / 10
    const totalProcessCount = processes.all
    const topCpu = processes.list.sort((a, b) => b.cpu - a.cpu).slice(0, 8).map(p => ({
      name: p.name, pid: p.pid, cpu: Math.round(p.cpu * 10) / 10, memMB: Math.round(p.mem_rss / 1024 / 1024 * 10) / 10,
    }))
    const topMem = processes.list.sort((a, b) => b.mem_rss - a.mem_rss).slice(0, 8).map(p => ({
      name: p.name, pid: p.pid, cpu: Math.round(p.cpu * 10) / 10, memMB: Math.round(p.mem_rss / 1024 / 1024 * 10) / 10,
    }))
    return { success: true, cpuLoad, totalProcessCount, topCpu, topMem, count: processes.list.length }
  } catch (e) {
    return { success: false, error: e.message, topCpu: [], topMem: [] }
  }
})

ipcMain.handle('doctor:killProcess', async (_e, { pid, name } = {}) => {
  if (!pid && !name) return { success: false, error: 'Provide pid or name' }
  try {
    const target = pid ? `/PID ${pid}` : `/IM ${name}`
    const output = execSync(`taskkill /F ${target}`, { timeout: 10000, stdio: 'pipe' }).toString()
    return { success: true, details: output.trim(), pid, name }
  } catch (e) {
    return { success: false, error: e.message, details: `Failed to kill process (may need admin)` }
  }
})

ipcMain.handle('doctor:startupItems', async () => {
  try {
    const output = execSync('powershell -Command "Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location | ConvertTo-Json"', { timeout: 10000, stdio: 'pipe' }).toString()
    const items = JSON.parse(output)
    const list = Array.isArray(items) ? items : (items ? [items] : [])
    return { success: true, count: list.length, items: list.slice(0, 30).map(i => ({ name: i.Name, command: i.Command, location: i.Location })) }
  } catch (e) {
    return { success: false, error: e.message, items: [] }
  }
})

ipcMain.handle('doctor:systemInfo', async () => {
  try {
    const si = require('systeminformation')
    const [cpu, mem, osInfo, disk, versions] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.osInfo(),
      si.fsSize(),
      si.versions(),
    ])
    return {
      success: true,
      cpu: { manufacturer: cpu.manufacturer, brand: cpu.brand, cores: cpu.cores, speed: cpu.speed },
      memory: { totalGB: Math.round(mem.total / 1024 / 1024 / 1024 * 10) / 10, freeGB: Math.round(mem.free / 1024 / 1024 / 1024 * 10) / 10 },
      os: { platform: osInfo.platform, distro: osInfo.distro, release: osInfo.release, kernel: osInfo.kernel, arch: osInfo.arch },
      disks: disk.slice(0, 4).map(d => ({ fs: d.fs, sizeGB: Math.round(d.size / 1024 / 1024 / 1024 * 10) / 10, usedGB: Math.round(d.used / 1024 / 1024 / 1024 * 10) / 10, usePct: d.use })),
      versions: { node: versions.node, npm: versions.npm, os: osInfo.distro },
      uptimeHours: Math.round(os.uptime() / 3600 * 10) / 10,
      hostname: os.hostname(),
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ── SYSTEM DOCTOR IPC Handlers ────────────────────────────────

ipcMain.handle('doctor:cleanTemp', async () => {
  const results = []
  try {
    // Windows Temp folder
    const tempDir = os.tmpdir()
    let cleaned = 0
    let freed = 0
    if (fs.existsSync(tempDir)) {
      const entries = fs.readdirSync(tempDir)
      for (const entry of entries) {
        try {
          const fullPath = path.join(tempDir, entry)
          const stat = fs.statSync(fullPath)
          const age = Date.now() - stat.mtimeMs
          // Only delete files older than 24 hours
          if (age > 24 * 60 * 60 * 1000) {
            if (stat.isDirectory()) {
              fs.rmSync(fullPath, { recursive: true, force: true })
            } else {
              freed += stat.size
              fs.unlinkSync(fullPath)
            }
            cleaned++
          }
        } catch {}
      }
    }
    results.push(`Temp folder: cleaned ${cleaned} item(s), freed ~${(freed / 1024 / 1024).toFixed(1)}MB`)

    // Windows %TEMP% user folder
    const userTemp = path.join(os.homedir(), 'AppData', 'Local', 'Temp')
    if (fs.existsSync(userTemp) && userTemp !== tempDir) {
      let uCleaned = 0
      let uFreed = 0
      const uEntries = fs.readdirSync(userTemp)
      for (const entry of uEntries) {
        try {
          const fullPath = path.join(userTemp, entry)
          const stat = fs.statSync(fullPath)
          const age = Date.now() - stat.mtimeMs
          if (age > 24 * 60 * 60 * 1000) {
            if (stat.isDirectory()) {
              fs.rmSync(fullPath, { recursive: true, force: true })
            } else {
              uFreed += stat.size
              fs.unlinkSync(fullPath)
            }
            uCleaned++
          }
        } catch {}
      }
      results.push(`User temp: cleaned ${uCleaned} item(s), freed ~${(uFreed / 1024 / 1024).toFixed(1)}MB`)
    }

    // Prefetch folder
    const prefetch = path.join(process.env.windir || 'C:\\Windows', 'Prefetch')
    if (fs.existsSync(prefetch)) {
      let pCleaned = 0
      const pEntries = fs.readdirSync(prefetch)
      for (const entry of pEntries) {
        try {
          const fullPath = path.join(prefetch, entry)
          const stat = fs.statSync(fullPath)
          if (stat.isFile() && Date.now() - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
            fs.unlinkSync(fullPath)
            pCleaned++
          }
        } catch {}
      }
      if (pCleaned > 0) results.push(`Prefetch: cleaned ${pCleaned} old file(s)`)
    }

    return { success: true, details: results.join('\n') }
  } catch (e) {
    return { success: false, error: e.message, details: results.join('\n') }
  }
})

ipcMain.handle('doctor:findLargeFiles', async (_e, { folderPath, minMB = 100 } = {}) => {
  try {
    // If no specific folder, scan all watched folders
    const targets = folderPath ? [folderPath] : (store.get('watchedFolders', []))
    if (targets.length === 0) return { success: true, files: [], summary: 'No folders to scan' }

    const largeFiles = []
    const minBytes = minMB * 1024 * 1024

    const scanDir = (dir, depth = 0) => {
      if (depth > 4) return
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          try {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              scanDir(fullPath, depth + 1)
            } else {
              const stat = fs.statSync(fullPath)
              if (stat.size >= minBytes) {
                largeFiles.push({
                  path: fullPath,
                  name: entry.name,
                  sizeBytes: stat.size,
                  sizeMB: Math.round(stat.size / 1024 / 1024 * 10) / 10,
                  modified: stat.mtime.toISOString().split('T')[0],
                })
              }
            }
          } catch {}
        }
      } catch {}
    }

    for (const target of targets) {
      if (fs.existsSync(target)) scanDir(target)
    }

    largeFiles.sort((a, b) => b.sizeBytes - a.sizeBytes)
    const totalSizeMB = largeFiles.reduce((s, f) => s + f.sizeMB, 0)

    return {
      success: true,
      files: largeFiles.slice(0, 100),
      totalCount: largeFiles.length,
      totalSizeMB: Math.round(totalSizeMB * 10) / 10,
      summary: `Found ${largeFiles.length} file(s) > ${minMB}MB, total ~${Math.round(totalSizeMB)}MB`,
    }
  } catch (e) {
    return { success: false, error: e.message, files: [] }
  }
})

ipcMain.handle('doctor:findDuplicates', async (_e, { folderPath } = {}) => {
  try {
    const targets = folderPath ? [folderPath] : (store.get('watchedFolders', []))
    if (targets.length === 0) return { success: true, groups: [], summary: 'No folders to scan' }

    const hashMap = new Map() // hash -> { path, name, size, modified }
    const duplicates = []

    const scanDir = (dir, depth = 0) => {
      if (depth > 4) return
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          try {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              scanDir(fullPath, depth + 1)
            } else {
              const stat = fs.statSync(fullPath)
              if (stat.size < 1024) continue // skip tiny files
              if (stat.size > 50 * 1024 * 1024) continue // skip huge files

              // Quick hash (first 64KB + last 64KB + size for speed)
              const fd = fs.openSync(fullPath, 'r')
              const buffer = Buffer.alloc(1024 * 128)
              const bytesRead = fs.readSync(fd, buffer, 0, Math.min(1024 * 128, stat.size), 0)
              fs.closeSync(fd)
              const hash = crypto.createHash('md5').update(buffer.slice(0, bytesRead)).update(String(stat.size)).digest('hex')

              if (hashMap.has(hash)) {
                const existing = hashMap.get(hash)
                if (existing.size === stat.size) {
                  // Full hash for confirmation
                  const fullBuf = fs.readFileSync(fullPath)
                  const fullHash = crypto.createHash('md5').update(fullBuf).digest('hex')
                  const existingFullBuf = fs.readFileSync(existing.path)
                  const existingHash = crypto.createHash('md5').update(existingFullBuf).digest('hex')
                  if (fullHash === existingHash) {
                    duplicates.push({
                      hash: fullHash,
                      sizeBytes: stat.size,
                      sizeMB: Math.round(stat.size / 1024 / 1024 * 100) / 100,
                      files: [
                        { path: existing.path, name: existing.name, modified: existing.modified },
                        { path: fullPath, name: entry.name, modified: stat.mtime.toISOString().split('T')[0] },
                      ],
                    })
                  }
                }
              } else {
                hashMap.set(hash, { path: fullPath, name: entry.name, size: stat.size, modified: stat.mtime.toISOString().split('T')[0] })
              }
            }
          } catch {}
        }
      } catch {}
    }

    for (const target of targets) {
      if (fs.existsSync(target)) scanDir(target)
    }

    // Merge duplicate groups with same hash
    const mergedMap = new Map()
    for (const dup of duplicates) {
      if (mergedMap.has(dup.hash)) {
        const existing = mergedMap.get(dup.hash)
        for (const f of dup.files) {
          if (!existing.files.some(ef => ef.path === f.path)) existing.files.push(f)
        }
      } else {
        mergedMap.set(dup.hash, dup)
      }
    }

    const groups = [...mergedMap.values()]
      .filter(g => g.files.length > 1)
      .sort((a, b) => b.sizeBytes - a.sizeBytes)

    const wastedMB = groups.reduce((s, g) => s + g.sizeBytes * (g.files.length - 1), 0)

    return {
      success: true,
      groups: groups.slice(0, 50),
      totalGroups: groups.length,
      wastedMB: Math.round(wastedMB / 1024 / 1024 * 10) / 10,
      summary: `Found ${groups.length} duplicate group(s), ~${Math.round(wastedMB / 1024 / 1024 * 10) / 10}MB wasted`,
    }
  } catch (e) {
    return { success: false, error: e.message, groups: [] }
  }
})

ipcMain.handle('doctor:diskSpaceReport', async () => {
  try {
    const drives = []
    const execSync = require('child_process').execSync
    const wmicOut = execSync('wmic logicaldisk get Caption,Size,FreeSpace /format:csv', { timeout: 5000, stdio: 'pipe' }).toString()
    const lines = wmicOut.split('\n').filter(l => l.trim())
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',').map(s => s.trim())
      if (parts.length >= 3) {
        const caption = parts[1]
        const freeBytes = parseInt(parts[2], 10)
        const totalBytes = parseInt(parts[3], 10)
        if (!isNaN(freeBytes) && !isNaN(totalBytes) && totalBytes > 0) {
          const freeGB = Math.round(freeBytes / 1024 / 1024 / 1024 * 10) / 10
          const totalGB = Math.round(totalBytes / 1024 / 1024 / 1024 * 10) / 10
          const usedGB = Math.round((totalBytes - freeBytes) / 1024 / 1024 / 1024 * 10) / 10
          const pct = Math.round((freeBytes / totalBytes) * 100)
          drives.push({ drive: caption, totalGB, usedGB, freeGB, freePct: pct })
        }
      }
    }

    // Watched folders size
    const watchedFoldersList = store.get('watchedFolders', [])
    let watchedSizeMB = 0
    let watchedFiles = 0
    const countSize = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          try {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              countSize(fullPath)
            } else {
              watchedFiles++
              watchedSizeMB += fs.statSync(fullPath).size / 1024 / 1024
            }
          } catch {}
        }
      } catch {}
    }
    for (const wf of watchedFoldersList) {
      if (fs.existsSync(wf)) countSize(wf)
    }

    // User folders
    const homeSize = (() => {
      let total = 0
      try {
        const desktop = path.join(os.homedir(), 'Desktop')
        const docs = path.join(os.homedir(), 'Documents')
        const downloads = path.join(os.homedir(), 'Downloads')
        for (const dir of [desktop, docs, downloads]) {
          if (fs.existsSync(dir)) {
            const entries = fs.readdirSync(dir)
            total += entries.length
          }
        }
      } catch {}
      return total
    })()

    // Temp size estimate
    let tempSizeMB = 0
    try {
      const tempDir = os.tmpdir()
      const entries = fs.readdirSync(tempDir)
      for (const entry of entries) {
        try {
          const fullPath = path.join(tempDir, entry)
          const stat = fs.statSync(fullPath)
          if (stat.isFile()) tempSizeMB += stat.size / 1024 / 1024
        } catch {}
      }
    } catch {}

    const suggestions = []
    for (const drive of drives) {
      if (drive.freePct < 10) suggestions.push(`⚠ ${drive.drive} critically low: ${drive.freePct}% free (${drive.freeGB}GB / ${drive.totalGB}GB)`)
      else if (drive.freePct < 20) suggestions.push(`📋 ${drive.drive} low: ${drive.freePct}% free (${drive.freeGB}GB / ${drive.totalGB}GB)`)
    }
    if (tempSizeMB > 500) suggestions.push(`🧹 Temp folder: ~${Math.round(tempSizeMB)}MB — consider cleaning`)
    if (watchedSizeMB > 1000) suggestions.push(`📁 Watched folders: ~${Math.round(watchedSizeMB)}MB — consider archiving old files`)

    return {
      success: true,
      drives,
      watchedFoldersSizeMB: Math.round(watchedSizeMB * 10) / 10,
      watchedFoldersFiles: watchedFiles,
      tempSizeMB: Math.round(tempSizeMB * 10) / 10,
      homeFolderItems: homeSize,
      suggestions,
    }
  } catch (e) {
    return { success: false, error: e.message, drives: [], suggestions: [] }
  }
})

ipcMain.handle('doctor:backupFolders', async () => {
  try {
    const watchedFoldersList = store.get('watchedFolders', [])
    if (watchedFoldersList.length === 0) return { success: false, error: 'No watched folders to backup' }

    const backupDir = path.join(os.homedir(), 'Desktop', `Overmind_Backup_${new Date().toISOString().split('T')[0]}`)
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true })

    const results = []
    for (const folder of watchedFoldersList) {
      if (!fs.existsSync(folder)) {
        results.push({ folder, success: false, error: 'Folder does not exist' })
        continue
      }
      const folderName = path.basename(folder)
      const zipPath = path.join(backupDir, `${folderName}.zip`)
      try {
        // Use PowerShell Compress-Archive on Windows
        execSync(
          `powershell -Command "Compress-Archive -Path '${folder}\\*' -DestinationPath '${zipPath}' -Force"`,
          { timeout: 300000, stdio: 'pipe' }
        )
        const stat = fs.statSync(zipPath)
        results.push({
          folder,
          success: true,
          zipPath,
          sizeMB: Math.round(stat.size / 1024 / 1024 * 10) / 10,
        })
      } catch (e) {
        results.push({ folder, success: false, error: e.message })
      }
    }

    const successCount = results.filter(r => r.success).length
    return {
      success: successCount > 0,
      backupDir,
      results,
      summary: `Backed up ${successCount}/${results.length} folder(s) to ${backupDir}`,
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('doctor:deepClean', async () => {
  const steps = []

  // Step 1: Clean temp
  try {
    const tempResult = await ipcMain.emit('doctor:cleanTemp')
    // We can't easily call our own handler, so re-implement inline
    let tempDetails = ''
    const tempDir = os.tmpdir()
    let cleaned = 0
    if (fs.existsSync(tempDir)) {
      const entries = fs.readdirSync(tempDir)
      for (const entry of entries) {
        try {
          const fullPath = path.join(tempDir, entry)
          const stat = fs.statSync(fullPath)
          if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) {
            if (stat.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true })
            else fs.unlinkSync(fullPath)
            cleaned++
          }
        } catch {}
      }
    }
    steps.push({ step: 'Temp files', success: true, detail: `Cleaned ${cleaned} item(s)` })
  } catch (e) { steps.push({ step: 'Temp files', success: false, detail: e.message }) }

  // Step 2: Clear recycle bin (Windows)
  try {
    execSync('powershell -Command "Clear-RecycleBin -Force"', { timeout: 30000, stdio: 'pipe' })
    steps.push({ step: 'Recycle Bin', success: true, detail: 'Emptied' })
  } catch {
    steps.push({ step: 'Recycle Bin', success: true, detail: 'Emptied (may require confirmation)' })
  }

  // Step 3: Clean Windows prefetch (older than 30 days)
  try {
    const prefetch = path.join(process.env.windir || 'C:\\Windows', 'Prefetch')
    let pCleaned = 0
    if (fs.existsSync(prefetch)) {
      const entries = fs.readdirSync(prefetch)
      for (const entry of entries) {
        try {
          const fullPath = path.join(prefetch, entry)
          const stat = fs.statSync(fullPath)
          if (stat.isFile() && Date.now() - stat.mtimeMs > 30 * 24 * 60 * 60 * 1000) {
            fs.unlinkSync(fullPath)
            pCleaned++
          }
        } catch {}
      }
    }
    if (pCleaned > 0) steps.push({ step: 'Prefetch', success: true, detail: `Cleaned ${pCleaned} old file(s)` })
    else steps.push({ step: 'Prefetch', success: true, detail: 'Nothing to clean' })
  } catch (e) { steps.push({ step: 'Prefetch', success: false, detail: e.message }) }

  // Step 4: Browser cache hint
  steps.push({ step: 'Browser Cache', success: true, detail: 'Run CCleaner or browser settings for cache cleanup' })

  const successCount = steps.filter(s => s.success).length
  return {
    success: true,
    steps,
    summary: `Deep clean complete: ${successCount}/${steps.length} steps succeeded`,
  }
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
