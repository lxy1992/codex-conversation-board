import AppKit
import WebKit

final class ConversationBoardAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var boardURL: URL!

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let configuredURL = Bundle.main.object(forInfoDictionaryKey: "BoardURL") as? String,
              let url = URL(string: configuredURL) else {
            showFatalError("App 配置缺少 BoardURL")
            return
        }

        boardURL = url
        installMainMenu()
        createWindow()
        showLoadingPage()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startLocalBoard()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            window.makeKeyAndOrderFront(nil)
        }
        return true
    }

    private func createWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        webView.setValue(false, forKey: "drawsBackground")

        let visibleFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let initialSize = NSSize(
            width: min(1440, visibleFrame.width * 0.92),
            height: min(900, visibleFrame.height * 0.92)
        )
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: initialSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "AI 对话看板"
        window.minSize = NSSize(width: 960, height: 620)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("AIConversationBoardMainWindow")
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 AI 对话看板", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 AI 对话看板", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h").keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 AI 对话看板", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "显示")
        let reloadItem = NSMenuItem(title: "刷新看板", action: #selector(reloadBoard), keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)
        viewMenu.addItem(.separator())
        viewMenu.addItem(withTitle: "进入全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func reloadBoard() {
        if isLocalBoardURL(webView.url) {
            webView.reload()
        } else {
            showLoadingPage()
            startLocalBoard()
        }
    }

    private func startLocalBoard() {
        guard let launcherPath = resolveLauncherPath() else {
            showFatalError("App 配置缺少本地服务启动路径")
            return
        }
        guard let nodePath = resolveNodePath() else {
            showFatalError("找不到 Node.js 22 或 Codex Desktop 自带的运行环境")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: nodePath)
            process.arguments = [launcherPath]
            var environment = ProcessInfo.processInfo.environment
            environment["CODEX_BOARD_SKIP_OPEN"] = "1"
            environment["CODEX_BOARD_SKIP_ALERT"] = "1"
            process.environment = environment
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice

            do {
                try process.run()
                process.waitUntilExit()
                guard process.terminationStatus == 0 else {
                    self?.showFatalErrorOnMainThread("本地看板服务启动失败，请查看 ~/Library/Logs/CodexConversationBoard/web.log")
                    return
                }
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.webView.load(URLRequest(url: self.boardURL))
                }
            } catch {
                self?.showFatalErrorOnMainThread("无法启动本地看板：\(error.localizedDescription)")
            }
        }
    }

    private func resolveLauncherPath() -> String? {
        guard let configuredPath = Bundle.main.object(forInfoDictionaryKey: "BoardLauncherPath") as? String,
              !configuredPath.isEmpty else {
            return nil
        }
        let launcherURL: URL
        if configuredPath.hasPrefix("/") {
            launcherURL = URL(fileURLWithPath: configuredPath)
        } else {
            guard let resourcesURL = Bundle.main.resourceURL else { return nil }
            launcherURL = resourcesURL.appendingPathComponent(configuredPath)
        }
        return FileManager.default.fileExists(atPath: launcherURL.path) ? launcherURL.path : nil
    }

    private func resolveNodePath() -> String? {
        var candidates: [String] = []
        if let configuredPath = Bundle.main.object(forInfoDictionaryKey: "BoardNodePath") as? String,
           !configuredPath.isEmpty {
            candidates.append(configuredPath)
        }
        candidates.append(contentsOf: [
            "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
            "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ])
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            candidates.append(contentsOf: path.split(separator: ":").map {
                String($0) + "/node"
            })
        }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func showLoadingPage() {
        let html = """
        <!doctype html><meta charset="utf-8">
        <style>
          :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
          body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f6f7f9; color:#172033; }
          .box { text-align:center; }
          .spinner { width:28px; height:28px; margin:0 auto 16px; border:3px solid #cbd5e1; border-top-color:#2563eb; border-radius:50%; animation:spin .75s linear infinite; }
          p { margin:0; font-size:15px; }
          @keyframes spin { to { transform:rotate(360deg); } }
          @media (prefers-color-scheme: dark) { body { background:#111315; color:#eef2f7; } }
        </style>
        <div class="box"><div class="spinner"></div><p>正在打开对话看板…</p></div>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func showFatalErrorOnMainThread(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            self?.showFatalError(message)
        }
    }

    private func showFatalError(_ message: String) {
        guard webView != nil else {
            let alert = NSAlert()
            alert.messageText = "无法打开对话看板"
            alert.informativeText = message
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        let html = """
        <!doctype html><meta charset="utf-8">
        <style>
          :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
          body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f6f7f9; color:#172033; }
          .box { width:min(560px,80vw); padding:32px; border:1px solid #d7dce5; border-radius:18px; background:#fff; box-shadow:0 12px 40px #0001; }
          h1 { font-size:22px; margin:0 0 12px; } p { margin:0; line-height:1.6; color:#64748b; }
          @media (prefers-color-scheme: dark) { body { background:#111315; color:#eef2f7; } .box { background:#1d2024; border-color:#3b424c; } }
        </style>
        <div class="box"><h1>看板没有载入</h1><p>\(escaped)</p><p>按 ⌘R 重试。</p></div>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func isLocalBoardURL(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == boardURL.scheme
            && url.host == boardURL.host
            && url.port == boardURL.port
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == "about" || isLocalBoardURL(url) {
            decisionHandler(.allow)
            return
        }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if isLocalBoardURL(url) {
            webView.load(URLRequest(url: url))
        } else {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}

@main
enum ConversationBoardApplication {
    static func main() {
        let application = NSApplication.shared
        let delegate = ConversationBoardAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
    }
}
