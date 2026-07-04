function init() {
    $ui.register((ctx) => {
        const VC = ctx.videoCore
        const hasVC = !!(VC && typeof VC.addEventListener === "function")

        const CFG_KEY = "cfg"
        const IDX_KEY = "pref:__index"
        const LOG_KEY = "log"
        const LOG_CAP = 30
        const CLICK_SUPPRESS = 2500
        const GRACE = 450
        const PICK_PENDING_MAX = 4000
        const POLL_ATTEMPTS = 8
        const POLL_INTERVAL = 350
        const MAX_CORRECTIONS = 8
        const REARM_DEDUP = 1500
        const QUALITY_DELAY = 1000
        const QUALITY_RESTORE_WINDOW = 8000
        const WATCHDOG_INTERVAL = 1500
        const OPT_SEL = "[data-vc-element='setting-select-option']"
        const LABEL_SEL = "[data-vc-element='setting-select-option-label']"
        const TITLE_SEL = "[data-vc-element='menu-title']"

        function sget<T>(k: string, d: T): T {
            try { const v = $storage.get<T>(k); return (v === undefined || v === null) ? d : v } catch (_e) { return d }
        }
        function sset(k: string, v: any): void { try { $storage.set(k, v) } catch (_e) {} }
        function nowMs(): number { try { return Date.now() } catch (_e) { return 0 } }

        let logs: string[] = sget<string[]>(LOG_KEY, [])
        if (!Array.isArray(logs)) logs = []
        function clock(): string {
            try {
                const d = new Date()
                const p2 = (n: number) => (n < 10 ? "0" : "") + n
                const p3 = (n: number) => (n < 100 ? (n < 10 ? "00" : "0") : "") + n
                return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "." + p3(d.getMilliseconds())
            } catch (_e) { return "" }
        }
        // Log lines arrive in bursts (arm + enforcement) — debounce the storage
        // write and only push a tray re-render while the log box is visible
        let logFlushTok = 0
        function log(msg: string): void {
            logs.push(clock() + "  " + msg)
            if (logs.length > LOG_CAP) logs = logs.slice(logs.length - LOG_CAP)
            logFlushTok++
            const tok = logFlushTok
            ctx.setTimeout(() => { if (tok === logFlushTok) sset(LOG_KEY, logs) }, 500)
            if (logsOpen.get()) { try { tray.update() } catch (_e) {} }
        }
        function shortPid(pid: string): string {
            const s = String(pid || "")
            return s.length > 14 ? "…" + s.slice(-12) : s
        }

        const cfg = sget<any>(CFG_KEY, {})
        const persistSubs = ctx.state<boolean>(cfg.subs !== false)
        const persistQuality = ctx.state<boolean>(cfg.quality !== false)
        const logsOpen = ctx.state<boolean>(false)

        function saveCfg(): void {
            sset(CFG_KEY, { subs: persistSubs.get(), quality: persistQuality.get() })
        }

        const ACCENT_SUBTLE: Record<string, string> = { background: "rgba(255,200,64,0.16)", border: "none", color: "#FFD27A", fontWeight: "500" }
        const ICON_FS = "18px"

        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/unkn0wncode/seanime-plugins/main/plugins/rains-utils/icon.png",
            withContent: true,
            width: "420px",
        })

        function styleEls(els: any[], pairs: [string, string][]): void {
            for (let i = 0; i < els.length; i++) {
                for (let j = 0; j < pairs.length; j++) {
                    try { els[i].setStyle(pairs[j][0], pairs[j][1]) } catch (_e) {}
                }
            }
        }
        try {
            if (ctx.dom && ctx.dom.observe) {
                ctx.dom.observe('[data-plugin-tray-popover-content="rain-utils"] [class*="max-h-[35rem]"]', (els) => {
                    styleEls(els, [["padding", "0px"]])
                })
                ctx.dom.observe('[data-plugin-tray-popover-content="rain-utils"]', (els) => {
                    styleEls(els, [["background", "transparent"], ["box-shadow", "none"], ["boxShadow", "none"], ["padding", "0px"]])
                })
            }
        } catch (_e) {}

        let gen = 0
        let armedPid = ""
        let lastArmAt = 0
        let lastMenu = ""
        let skipClicks = false
        const boundOpts: any = {}
        const pendingClick: any = { sub: 0, cap: 0, q: 0 }
        const pickPending: any = { sub: false, cap: false }
        const enforceCount: any = { sub: 0, cap: 0 }
        const lastDesired: any = { sub: -999, cap: -999 }
        const stopEnforce: any = { sub: false, cap: false }
        const curTrack: any = { sub: -999, cap: -999 }
        const enforceTok: any = { sub: 0, cap: 0 }

        function pinfo(): any { try { return VC.getCurrentPlaybackInfo() || null } catch (_e) { return null } }
        function curMediaId(): number {
            try { const m = VC.getCurrentMedia(); if (m && typeof m.id === "number") return m.id } catch (_e) {}
            const pi = pinfo()
            if (pi) {
                if (pi.media && typeof pi.media.id === "number") return pi.media.id
                if (pi.onlinestreamParams && typeof pi.onlinestreamParams.mediaId === "number") return pi.onlinestreamParams.mediaId
            }
            return 0
        }
        function curEpisode(): number {
            const pi = pinfo()
            if (pi) {
                if (pi.episode && typeof pi.episode.episodeNumber === "number") return pi.episode.episodeNumber
                if (pi.onlinestreamParams && typeof pi.onlinestreamParams.episodeNumber === "number") return pi.onlinestreamParams.episodeNumber
            }
            return 0
        }

        function writeKey(): string { return "pref:global" }
        function readCascade(): any {
            const g = sget<any>("pref:global", null)
            if (!g) return null
            return (g.sub || g.cap || g.quality) ? g : null
        }
        function ctxStr(): string { return "media=" + curMediaId() + " · ep=" + curEpisode() }

        function indexAdd(k: string): void {
            const idx = sget<string[]>(IDX_KEY, [])
            if (idx.indexOf(k) < 0) { idx.push(k); sset(IDX_KEY, idx) }
        }
        function recordTo(k: string, patch: any): void {
            if (!k) return
            const cur = sget<any>(k, {})
            sset(k, Object.assign({}, cur, patch, { updatedAt: nowMs() }))
            indexAdd(k)
        }
        function matchTrack(list: any[], want: any): number {
            const lang = String(want.language || "").toLowerCase()
            const label = String(want.label || "").toLowerCase()
            for (let i = 0; i < list.length; i++) if (lang && String(list[i].language || "").toLowerCase() === lang) return list[i].number
            for (let i = 0; i < list.length; i++) if (label && String(list[i].label || "").toLowerCase() === label) return list[i].number
            return -2
        }
        function matchByLabel(list: any[], label: string): any {
            const L = label.toLowerCase(); const U = label.toUpperCase()
            for (let i = 0; i < list.length; i++) if (String(list[i].label || "").toLowerCase() === L) return list[i]
            for (let i = 0; i < list.length; i++) if (String(list[i].language || "").toLowerCase() === L) return list[i]
            for (let i = 0; i < list.length; i++) if (String(list[i].language || "").toUpperCase() === U) return list[i]
            return null
        }

        function savedFor(kind: string): any {
            const rec = readCascade()
            if (!rec) return null
            return kind === "sub" ? (rec.sub || null) : (rec.cap || null)
        }

        function setKind(kind: string, n: number, myGen: number): void {
            if (myGen !== gen) return
            if (n === lastDesired[kind]) {
                enforceCount[kind]++
                if (enforceCount[kind] > MAX_CORRECTIONS) {
                    if (!stopEnforce[kind]) { stopEnforce[kind] = true; log("⚠ " + kind + " enforcement paused — player keeps overriding (" + n + ")") }
                    return
                }
            } else { lastDesired[kind] = n; enforceCount[kind] = 1 }
            try {
                if (kind === "sub") VC.setSubtitleTrack(n)
                else VC.setMediaCaptionTrack(n)
                log("→ " + (kind === "sub" ? "setSubtitleTrack" : "setMediaCaptionTrack") + "(" + n + ")")
            } catch (_e) {}
        }

        function enforceKind(kind: string, current: number, myGen: number): Promise<string> {
            if (myGen !== gen) return Promise.resolve("stale")
            if (!persistSubs.get()) return Promise.resolve("off")
            if (stopEnforce[kind]) return Promise.resolve("stopped")
            if (pickPending[kind] || nowMs() - pendingClick[kind] <= CLICK_SUPPRESS) return Promise.resolve("user")
            const sv = savedFor(kind)
            if (!sv) return Promise.resolve("none")
            // current === -999 means no track event arrived (some servers never
            // forward videocore events) — apply one-shot instead of bailing
            return VC.getTextTracks().then((tracks) => {
                if (myGen !== gen) return "stale"
                const subs = (tracks || []).filter((t) => t.type === "subtitles")
                const caps = (tracks || []).filter((t) => t.type === "captions")
                if (!subs.length && !caps.length) return "no-tracks"
                if (sv.off) {
                    if (current === -1) { enforceCount[kind] = 0; return "ok" }
                    setKind(kind, -1, myGen); return "applied"
                }
                const list = kind === "cap" ? caps : subs
                const n = matchTrack(list, sv)
                if (n === -2) { return "no-match" }
                if (current === n) { enforceCount[kind] = 0; return "ok" }
                setKind(kind, n, myGen); return "applied"
            }).catch(() => "error")
        }

        function scheduleEnforce(kind: string): void {
            if (stopEnforce[kind]) return
            enforceTok[kind]++
            const tok = enforceTok[kind]
            const myGen = gen
            ctx.setTimeout(() => {
                if (myGen !== gen || enforceTok[kind] !== tok) return
                enforceKind(kind, curTrack[kind], myGen)
            }, GRACE)
        }

        function pollLoad(myGen: number, attempt: number): void {
            if (myGen !== gen) return
            Promise.all([
                enforceKind("sub", curTrack.sub, myGen),
                enforceKind("cap", curTrack.cap, myGen),
            ]).then((st) => {
                if (myGen !== gen) return
                if ((st.indexOf("no-tracks") >= 0 || st.indexOf("unknown") >= 0) && attempt < POLL_ATTEMPTS) {
                    ctx.setTimeout(() => pollLoad(myGen, attempt + 1), POLL_INTERVAL)
                }
            }).catch(() => {})
        }

        // Quality save/restore.
        // There is no VideoCore API or server event for quality (HLS levels are switched
        // purely client-side), so restore drives the player's own Quality menu invisibly
        // via page JS. Seanime sanitizes setInnerHTML (blocking <script>, onerror, etc.)
        // unless the plugin holds the "dom-script-manipulation" unsafe flag — declared in
        // manifest.json. With it granted, the sanitizer is bypassed and an <img onerror>
        // fires the payload on insertion (innerHTML-inserted <script> never executes, so
        // the image-error handler is the reliable trigger). The broken data URI errors
        // immediately with no network request.
        function injectJS(code: string): void {
            try {
                ctx.dom.createElement("div").then((host: any) => {
                    const enc = encodeURIComponent(code).replace(/'/g, "%27")
                    host.setInnerHTML("<img src=\"data:image/gif;base64,!\" onerror=\"eval(decodeURIComponent('" + enc + "'))\">")
                    ctx.setTimeout(() => { try { host.remove() } catch (_e) {} }, 15000)
                }).catch(() => { log("⚠ inject failed (createElement)") })
            } catch (_e) { log("⚠ inject failed (dom api unavailable)") }
        }

        function qualityRestoreJS(label: string): string {
            return "(function(){" +
                "var want=" + JSON.stringify(String(label).trim().toLowerCase()) + ";" +
                "function mark(s){try{document.body.setAttribute('data-aq-qr',s)}catch(e){}}" +
                "mark('start');" +
                "if(window.__aqQR){try{window.__aqQR.cancel()}catch(e){}}" +
                "var dead=Date.now()+" + QUALITY_RESTORE_WINDOW + ";" +
                "var st=document.createElement('style');" +
                "st.id='aq-qr-style';" +
                "st.textContent='[data-radix-popper-content-wrapper]{opacity:0 !important;transition:none !important;animation:none !important}';" +
                "var opened=false,trig=null,done=false;" +
                "function norm(s){return String(s||'').trim().toLowerCase()}" +
                "function closeMenu(){try{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true,cancelable:true}))}catch(e){}}" +
                "function cleanup(){if(done)return;done=true;if(opened&&qualityOpen())closeMenu();setTimeout(function(){try{st.remove()}catch(e){}},1200)}" +
                "window.__aqQR={cancel:cleanup};" +
                "function findTrig(){var ps=document.querySelectorAll('[data-vc-element=\"control-button\"] svg path');for(var i=0;i<ps.length;i++){if((ps[i].getAttribute('d')||'')==='M7 3v18'){var b=ps[i].closest('[data-vc-element=\"control-button\"]');if(b)return b}}return null}" +
                "function qualityOpen(){var ts=document.querySelectorAll('[data-vc-element=\"menu-title\"]');for(var i=0;i<ts.length;i++){if(norm(ts[i].textContent)==='quality')return true}return false}" +
                "function tick(){" +
                "if(done)return;" +
                "if(Date.now()>dead){mark(opened?'timeout-menu':'timeout-no-trigger');cleanup();return}" +
                "if(!opened){trig=findTrig();if(!trig){setTimeout(tick,400);return}document.head.appendChild(st);trig.click();opened=true;mark('opened');setTimeout(tick,120);return}" +
                "if(!qualityOpen()){setTimeout(tick,150);return}" +
                "var opts=document.querySelectorAll('[data-vc-element=\"setting-select-option\"]');" +
                "if(!opts.length){setTimeout(tick,150);return}" +
                "var target=null,seen=[];" +
                "for(var i=0;i<opts.length;i++){var lab=opts[i].querySelector('[data-vc-element=\"setting-select-option-label\"]');var lt=lab?norm(lab.textContent):'';seen.push(lt);if(lt===want){target=opts[i];break}}" +
                "if(!target){mark('no-match ['+seen.join('|')+']');cleanup();return}" +
                "var ind=target.querySelector('[data-vc-element=\"setting-select-option-indicator\"]');" +
                "if(ind&&ind.querySelector('svg')){mark('already')}else{target.click();mark('clicked')}" +
                "cleanup()" +
                "}" +
                "tick()" +
                "})();"
        }

        function enforceQuality(myGen: number): void {
            if (myGen !== gen) { log("· quality restore skipped (stale gen)"); return }
            if (!persistQuality.get()) return
            const rec = readCascade()
            const q = rec && rec.quality
            if (!q || !q.label) { log("· quality restore: nothing saved"); return }
            if (nowMs() - pendingClick.q <= CLICK_SUPPRESS) { log("· quality restore skipped (recent pick)"); return }
            log("→ restoring quality '" + q.label + "'")
            injectJS(qualityRestoreJS(q.label))
            // The menu-driving runs in the web page (invisible to this log). It stamps
            // progress onto body[data-aq-qr]; poll that and mirror each state change here
            // so the log narrates what the injected script is doing.
            let lastMark = ""
            let sawAny = false
            const deadline = nowMs() + QUALITY_RESTORE_WINDOW + 1500
            const pollMark = () => {
                if (myGen !== gen) return
                ctx.dom.queryOne("body").then((b: any) => b ? b.getAttribute("data-aq-qr") : null).then((v: any) => {
                    if (myGen !== gen) return
                    const mark = v ? String(v) : ""
                    if (mark) sawAny = true
                    if (mark && mark !== lastMark) { lastMark = mark; log("· restore: " + mark) }
                    const settled = /^(clicked|already|no-match|timeout)/.test(lastMark)
                    if (settled) return
                    if (nowMs() >= deadline) { if (!sawAny) log("· restore: no signal — injected JS never ran (unsafe flag not granted?)"); return }
                    ctx.setTimeout(pollMark, 500)
                }).catch(() => { if (nowMs() < deadline) ctx.setTimeout(pollMark, 500) })
            }
            ctx.setTimeout(pollMark, 400)
        }

        function arm(pid: string, fromLoad: boolean): void {
            if (!pid) return
            if (fromLoad) { if (pid === armedPid && nowMs() - lastArmAt < REARM_DEDUP) return }
            else { if (pid === armedPid) return }
            const reload = (pid === armedPid)
            armedPid = pid
            lastArmAt = nowMs()
            gen++
            const ks = ["sub", "cap"]
            for (let i = 0; i < ks.length; i++) { const k = ks[i]; enforceCount[k] = 0; lastDesired[k] = -999; stopEnforce[k] = false; pickPending[k] = false; pendingClick[k] = 0; curTrack[k] = -999 }
            for (const id in boundOpts) delete boundOpts[id]
            log("▶ LOAD" + (reload ? " (reload)" : "") + " pid=" + shortPid(pid) + " · " + ctxStr())
            pollLoad(gen, 0)
            const myGen = gen
            ctx.setTimeout(() => enforceQuality(myGen), QUALITY_DELAY)
        }

        function menuSkips(t: string): boolean {
            const s = String(t || "").toLowerCase()
            return s.indexOf("settings") >= 0 || s.indexOf("audio") >= 0
        }
        function isQualityMenu(): boolean {
            return String(lastMenu || "").toLowerCase().indexOf("quality") >= 0
        }

        function recordByLabel(el: any, done: () => void): void {
            el.query(LABEL_SEL).then((spans: any[]) => {
                const sp = (spans && spans.length) ? spans[0] : el
                return sp.getText()
            }).then((txt: string) => {
                const label = String(txt || "").trim()
                if (!label) { log("· click: could not read label"); done(); return }
                log("· you picked '" + label + "' (" + (lastMenu || "?") + ")")
                if (/^off$/i.test(label)) { const key = writeKey(); recordTo(key, { sub: { off: true }, cap: null }); log("✓ saved sub=off @ " + key); done(); return }
                VC.getTextTracks().then((tracks) => {
                    const subs = (tracks || []).filter((t) => t.type === "subtitles")
                    const caps = (tracks || []).filter((t) => t.type === "captions")
                    const m = matchByLabel(subs, label)
                    if (m) { const key = writeKey(); recordTo(key, { sub: { off: false, language: m.language, label: m.label }, cap: null }); log("✓ saved sub=" + (m.label || m.language) + " @ " + key); done(); return }
                    const cm = matchByLabel(caps, label)
                    if (cm) { const key = writeKey(); recordTo(key, { cap: { off: false, language: cm.language, label: cm.label }, sub: null }); log("✓ saved cap=" + (cm.label || cm.language) + " @ " + key); done(); return }
                    if (/^(auto$|\d{3,4}p)/i.test(label)) { const key = writeKey(); recordTo(key, { quality: { label: label } }); log("✓ saved quality=" + label + " @ " + key); done(); return }
                    log("· '" + label + "' matched no track — not saved"); done()
                }).catch(() => { log("· getTextTracks error"); done() })
            }).catch(() => { log("· click: could not read label"); done() })
        }

        function recordQualityByLabel(el: any): void {
            el.query(LABEL_SEL).then((spans: any[]) => {
                const sp = (spans && spans.length) ? spans[0] : el
                return sp.getText()
            }).then((txt: string) => {
                const label = String(txt || "").trim()
                if (!label) { log("· click: could not read label"); return }
                const key = writeKey()
                recordTo(key, { quality: { label: label } })
                log("✓ saved quality=" + label + " @ " + key)
            }).catch(() => { log("· click: could not read label") })
        }

        function onOptionClick(el: any): void {
            if (skipClicks) { log("· click ignored (" + (lastMenu || "?") + ")"); return }
            if (isQualityMenu()) {
                // #aq-qr-style only exists while the injected restore sequence is
                // driving the menu — its clicks are synthetic, not user picks
                ctx.dom.queryOne("#aq-qr-style").then((stEl: any) => {
                    if (stEl) return
                    pendingClick.q = nowMs()
                    recordQualityByLabel(el)
                }).catch(() => {
                    pendingClick.q = nowMs()
                    recordQualityByLabel(el)
                })
                return
            }
            const kinds = ["sub", "cap"]
            const t = nowMs()
            for (let i = 0; i < kinds.length; i++) { pendingClick[kinds[i]] = t; pickPending[kinds[i]] = true }
            const clearPending = () => { for (let i = 0; i < kinds.length; i++) pickPending[kinds[i]] = false }
            ctx.setTimeout(clearPending, PICK_PENDING_MAX)
            recordByLabel(el, clearPending)
        }

        if (hasVC) {
            try {
                ctx.dom.observe(TITLE_SEL, (els) => {
                    if (!els || !els.length) return
                    const el = els[els.length - 1]
                    try {
                        el.getText().then((t) => {
                            const skip = menuSkips(t)
                            const name = String(t || "").trim()
                            if (name && name !== lastMenu) { lastMenu = name; log("· menu open: " + name + (skip ? " (clicks ignored)" : "")) }
                            skipClicks = skip
                        }).catch(() => {})
                    } catch (_e) {}
                })
            } catch (_e) {}
            try {
                ctx.dom.observe(OPT_SEL, (els) => {
                    if (!els || !els.length) return
                    for (let i = 0; i < els.length; i++) {
                        const el = els[i]
                        const id = el && el.id
                        if (!id || boundOpts[id]) continue
                        boundOpts[id] = true
                        try { el.addEventListener("click", () => onOptionClick(el)) } catch (_e) {}
                    }
                })
            } catch (_e) {}

            // The watchdog only exists for servers that never forward videocore
            // events — the first real event proves they work, so stop polling
            let cancelWatchdog: (() => void) | null = null
            function eventsProven(): void {
                if (!cancelWatchdog) return
                try { cancelWatchdog() } catch (_e) {}
                cancelWatchdog = null
                log("· watchdog stopped (events work)")
            }

            VC.addEventListener("video-loaded", (e) => { eventsProven(); arm((e && e.playbackId) || "", true) })
            VC.addEventListener("video-loaded-metadata", (e) => { eventsProven(); arm((e && e.playbackId) || "", true) })

            VC.addEventListener("video-subtitle-track", (e) => {
                eventsProven()
                arm((e && e.playbackId) || "", false)
                const v = (typeof e.trackNumber === "number" && e.trackNumber >= 0) ? e.trackNumber : -1
                curTrack.sub = v
                scheduleEnforce("sub")
            })
            VC.addEventListener("video-media-caption-track", (e) => {
                eventsProven()
                arm((e && e.playbackId) || "", false)
                const v = (typeof e.trackIndex === "number" && e.trackIndex >= 0) ? e.trackIndex : -1
                curTrack.cap = v
                scheduleEnforce("cap")
            })

            // Some servers never forward videocore events to plugins even though the
            // request/response APIs work — poll the playback info as an arm fallback
            try {
                cancelWatchdog = ctx.setInterval(() => {
                    const pi = pinfo()
                    const id = (pi && pi.id) ? String(pi.id) : ""
                    if (id && id !== armedPid) { log("· watchdog: playback detected"); arm(id, true) }
                }, WATCHDOG_INTERVAL)
            } catch (_e) {}
        }

        function dim(t: string): any {
            return tray.text(t, { style: { color: "rgba(255,255,255,0.5)", fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" } })
        }
        function heading(t: string): any {
            return tray.text(t, { style: { fontSize: "11px", fontWeight: "600", letterSpacing: "0.06em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginTop: "2px" } })
        }
        function divider(): any {
            return tray.div({ items: [], style: { marginTop: "5px", marginBottom: "5px" } })
        }
        function toggleRow(on: boolean, click: string, label: string): any {
            return tray.flex({
                items: [
                    tray.button({ label: on ? "✓" : "✕", onClick: click, intent: "gray-subtle", size: "sm", style: on ? { ...ACCENT_SUBTLE, fontSize: ICON_FS } : { fontSize: ICON_FS } }),
                    tray.text(label, { style: { fontSize: "13px", color: "rgba(255,255,255,0.85)", overflowWrap: "anywhere", wordBreak: "break-word" } }),
                ],
                gap: 2,
                style: { alignItems: "center" },
            })
        }
        function panel(rows: any[]): any {
            return tray.stack({
                items: rows,
                gap: 3,
                style: {
                    display: "flex",
                    flexDirection: "column",
                    padding: "18px 16px",
                    background: "linear-gradient(180deg, rgba(18,19,24,0.40), rgba(10,11,15,0.52))",
                    backdropFilter: "blur(30px) saturate(115%)",
                    WebkitBackdropFilter: "blur(30px) saturate(115%)",
                    border: "none",
                    outline: "none",
                    borderRadius: "16px",
                    boxShadow: "0 24px 60px -12px rgba(0,0,0,0.7)",
                },
            })
        }
        function logBox(): any {
            const tail = logs.slice(-30).join("\n")
            return tray.div({
                items: [tray.text(tail || "(no logs yet — play something and change a track)", { style: { fontSize: "11px", fontFamily: "ui-monospace, monospace", lineHeight: "1.5", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", color: "rgba(255,255,255,0.75)" } })],
                style: { background: "rgba(0,0,0,0.28)", borderRadius: "10px", padding: "10px 12px", maxHeight: "220px", overflowY: "auto" },
            })
        }

        ctx.registerEventHandler("ap-subs", () => { persistSubs.set(!persistSubs.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-quality", () => { persistQuality.set(!persistQuality.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-log-copy", () => { try { ctx.dom.clipboard.write(logs.join("\n")) } catch (_e) {} ctx.toast.success("Logs copied to clipboard") })
        ctx.registerEventHandler("ap-log-clear", () => { logs = []; logFlushTok++; sset(LOG_KEY, logs); ctx.toast.info("Logs cleared"); tray.update() })
        ctx.registerEventHandler("ap-log-toggle", () => { logsOpen.set(!logsOpen.get()); tray.update() })

        function renderTray(): any {
            const rows: any[] = []

            if (!hasVC) {
                rows.push(dim("Needs the Playback permission — re-enable the plugin's permissions or update Seanime."))
                return panel(rows)
            }

            rows.push(toggleRow(persistSubs.get(), "ap-subs", "Remember subtitle & caption choices"))
            rows.push(toggleRow(persistQuality.get(), "ap-quality", "Remember quality choice"))

            rows.push(divider())
            rows.push(tray.flex({
                items: [
                    heading("Logs"),
                    tray.button({ label: logsOpen.get() ? "Hide" : "Show", onClick: "ap-log-toggle", intent: "gray-subtle", size: "xs", style: { marginLeft: "auto" } }),
                    tray.button({ label: "Copy", onClick: "ap-log-copy", intent: "gray-subtle", size: "xs" }),
                    tray.button({ label: "Clear", onClick: "ap-log-clear", intent: "alert-subtle", size: "xs" }),
                ],
                gap: 2,
                style: { alignItems: "center" },
            }))
            if (logsOpen.get()) rows.push(logBox())
            return panel(rows)
        }

        tray.render(renderTray)
    })
}
