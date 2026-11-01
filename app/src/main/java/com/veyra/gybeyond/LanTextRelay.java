package com.veyra.gybeyond;

import android.os.Build;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 局域网文本中继：在手机上开一个极小的 HTTP 服务，同一 Wi-Fi 下的任意设备扫码打开页面，
 * 把文字发过来，直接填进 App 当前聚焦的输入框。电视上遥控器打字困难时用这个。
 *
 * 只用 JDK 自带的 ServerSocket，不引第三方框架；端口 8765 起顺延，最多试 20 个。
 * 每次进程启动生成一次性 token，二维码 URL 里带上，别人即使知道地址也发不进来。
 */
final class LanTextRelay {
    interface Listener {
        /** 收到文本（任意线程回调，调用方自行切主线程）。 */
        void onText(String text);
    }

    private static final int FIRST_PORT = 8765;
    private static final int LAST_PORT = 8784;
    private static final int MAX_TEXT = 4000;

    private final Listener listener;
    private final String token;
    private final ExecutorService pool = Executors.newFixedThreadPool(4, runnable -> {
        Thread thread = new Thread(runnable, "veyra-relay");
        thread.setDaemon(true);
        return thread;
    });

    private volatile ServerSocket server;
    private volatile int port;
    private volatile boolean running;
    private volatile String address = "";
    private volatile long receivedAt;

    LanTextRelay(Listener listener) {
        this.listener = listener;
        this.token = String.format("%06x", (int) (Math.random() * 0xFFFFFF));
    }

    void start() {
        if (running) return;
        running = true;
        Thread thread = new Thread(this::serve, "veyra-relay-accept");
        thread.setDaemon(true);
        thread.start();
    }

    void stop() {
        running = false;
        ServerSocket socket = server;
        server = null;
        port = 0;
        if (socket != null) {
            try { socket.close(); } catch (IOException ignored) { }
        }
        pool.shutdownNow();
    }

    /** 供页面查询：未就绪时 url 为空，前端轮询到有值再画二维码。 */
    String url() {
        return address.isEmpty() || port == 0 ? "" : "http://" + address + ":" + port + "/?t=" + token;
    }

    String address() { return address; }

    int port() { return port; }

    long lastReceivedAt() { return receivedAt; }

    private void serve() {
        for (int candidate = FIRST_PORT; candidate <= LAST_PORT && running; candidate++) {
            try {
                ServerSocket socket = new ServerSocket();
                socket.setReuseAddress(true);
                socket.bind(new InetSocketAddress(candidate), 8);
                server = socket;
                port = candidate;
                address = resolveLanAddress();
                break;
            } catch (IOException ignored) {
                // 端口被占（常见于同时开了别的调试服务），换下一个
            }
        }
        ServerSocket socket = server;
        if (socket == null) return;
        while (running) {
            try {
                Socket client = socket.accept();
                pool.execute(() -> handle(client));
            } catch (IOException error) {
                if (!running) return;
            }
        }
    }

    private void handle(Socket client) {
        try (Socket socket = client) {
            socket.setSoTimeout(8000);
            InputStream input = new BufferedInputStream(socket.getInputStream());
            String head = readHead(input);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            if (lines.length == 0) return;
            String[] request = lines[0].split(" ");
            if (request.length < 2) return;
            String method = request[0];
            String target = request[1];

            int contentLength = 0;
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon <= 0) continue;
                if ("content-length".equalsIgnoreCase(lines[i].substring(0, colon).trim())) {
                    try { contentLength = Integer.parseInt(lines[i].substring(colon + 1).trim()); } catch (NumberFormatException ignored) { }
                }
            }

            int queryIndex = target.indexOf('?');
            String path = queryIndex < 0 ? target : target.substring(0, queryIndex);
            String query = queryIndex < 0 ? "" : target.substring(queryIndex + 1);

            if ("GET".equals(method) && ("/".equals(path) || "/index.html".equals(path))) {
                if (!tokenMatches(query)) {
                    respond(socket, 403, "text/html; charset=utf-8", page("链接已失效", "<p class=\"hint\">请回到 App 重新打开二维码。</p>"));
                    return;
                }
                respond(socket, 200, "text/html; charset=utf-8", inputPage(token));
                return;
            }
            if ("POST".equals(method) && "/send".equals(path)) {
                if (!tokenMatches(query)) {
                    respond(socket, 403, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"token\"}");
                    return;
                }
                byte[] body = readBody(input, contentLength);
                String text = new String(body, StandardCharsets.UTF_8).trim();
                if (text.length() > MAX_TEXT) text = text.substring(0, MAX_TEXT);
                if (text.isEmpty()) {
                    respond(socket, 400, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"empty\"}");
                    return;
                }
                receivedAt = System.currentTimeMillis();
                listener.onText(text);
                respond(socket, 200, "application/json; charset=utf-8", "{\"ok\":true}");
                return;
            }
            if ("GET".equals(method) && "/favicon.ico".equals(path)) {
                respond(socket, 204, "text/plain", "");
                return;
            }
            respond(socket, 404, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"not found\"}");
        } catch (Exception ignored) {
            // 局域网里各种半开连接、浏览器预连接都会走到这里，静默丢弃
        }
    }

    private boolean tokenMatches(String query) {
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && "t".equals(pair.substring(0, eq))) {
                return token.equals(pair.substring(eq + 1));
            }
        }
        return false;
    }

    /** 读到空行为止（\r\n\r\n），返回纯 ASCII 头；body 仍留在流里等 readBody。 */
    private static String readHead(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int state = 0;
        while (buffer.size() < 8192) {
            int b = input.read();
            if (b < 0) return null;
            buffer.write(b);
            if (b == '\r') state = state == 2 ? 3 : 1;
            else if (b == '\n') state = state == 1 ? 2 : (state == 3 ? 4 : 0);
            else state = 0;
            if (state == 4) break;
        }
        return new String(buffer.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private static byte[] readBody(InputStream input, int length) throws IOException {
        int size = Math.max(0, Math.min(length, 64 * 1024));
        byte[] data = new byte[size];
        int offset = 0;
        while (offset < size) {
            int read = input.read(data, offset, size - offset);
            if (read < 0) break;
            offset += read;
        }
        return data;
    }

    private static void respond(Socket socket, int status, String type, String body) throws IOException {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + status + " " + (status == 200 ? "OK" : status == 204 ? "No Content" : status == 403 ? "Forbidden" : status == 400 ? "Bad Request" : "Not Found") + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + payload.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        OutputStream output = socket.getOutputStream();
        output.write(header.getBytes(StandardCharsets.ISO_8859_1));
        output.write(payload);
        output.flush();
    }

    static String resolveLanAddress() {
        String fallback = "";
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface network = interfaces.nextElement();
                if (!network.isUp() || network.isLoopback()) continue;
                String name = network.getName() == null ? "" : network.getName();
                if (name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("p2p")) continue; // 蜂窝/热点直连不算同一局域网
                for (InterfaceAddress entry : network.getInterfaceAddresses()) {
                    InetAddress address = entry.getAddress();
                    if (!(address instanceof Inet4Address) || address.isLoopbackAddress()) continue;
                    if (address.isSiteLocalAddress()) return address.getHostAddress();
                    if (fallback.isEmpty()) fallback = address.getHostAddress();
                }
            }
        } catch (Exception ignored) { }
        return fallback;
    }

    private static String page(String title, String body) {
        return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<title>" + title + "</title><style>"
                + "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;"
                + "background:#12141a;color:#f3efe4;font:16px/1.6 -apple-system,\"PingFang SC\",\"Noto Sans CJK SC\",sans-serif;padding:24px}"
                + ".card{width:100%;max-width:520px;background:#1b1e26;border:1px solid #2c313c;border-radius:18px;padding:24px}"
                + "h1{font-size:19px;margin:0 0 6px}p.sub{margin:0 0 18px;color:#9aa2b1;font-size:13px}"
                + "textarea{width:100%;min-height:132px;box-sizing:border-box;background:#12141a;color:#f3efe4;border:1px solid #2c313c;"
                + "border-radius:12px;padding:12px;font:16px/1.5 inherit;outline:none;resize:vertical}"
                + "textarea:focus{border-color:#c89b3c}"
                + "button{width:100%;margin-top:14px;background:#c89b3c;color:#231a06;border:none;border-radius:12px;padding:13px;"
                + "font-size:16px;font-weight:700}"
                + "button:disabled{opacity:.5}"
                + ".status{margin-top:12px;font-size:13px;color:#9aa2b1;min-height:20px}"
                + ".status.ok{color:#4cc17a}.status.err{color:#e26a6a}"
                + ".hint{color:#9aa2b1;font-size:14px}</style></head><body><div class=\"card\">"
                + body + "</div></body></html>";
    }

    private String inputPage(String token) {
        String device = Build.MODEL == null ? "设备" : Build.MODEL;
        String body = "<h1>发送到 " + escapeHtml(device) + "</h1>"
                + "<p class=\"sub\">文字会直接填入 App 里正在输入的框</p>"
                + "<textarea id=\"t\" autofocus placeholder=\"在这里输入或粘贴，发送后 App 立即收到\"></textarea>"
                + "<button id=\"send\">发送</button><div class=\"status\" id=\"s\"></div>"
                + "<script>(function(){var ta=document.getElementById('t'),btn=document.getElementById('send'),"
                + "st=document.getElementById('s'),tk=" + jsString(token) + ";"
                + "function say(msg,cls){st.textContent=msg;st.className='status '+(cls||'')}"
                + "function send(){var text=ta.value;if(!text.trim()){say('内容为空','err');return}"
                + "btn.disabled=true;say('发送中…');"
                + "fetch('/send?t='+encodeURIComponent(tk),{method:'POST',body:text})"
                + ".then(function(r){return r.json()}).then(function(d){"
                + "if(d&&d.ok){say('已发送，可以继续修改再发','ok');btn.disabled=false}"
                + "else{say('发送失败：'+(d&&d.error||'未知'),'err');btn.disabled=false}})"
                + ".catch(function(){say('连不上手机，确认在同一 Wi-Fi','err');btn.disabled=false})}"
                + "btn.addEventListener('click',send);"
                + "ta.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();send()}});"
                + "})();</script>";
        return page("Veyra 输入", body);
    }

    private static String escapeHtml(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private static String jsString(String value) {
        StringBuilder builder = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') builder.append('\\').append(c);
            else if (c < 0x20) builder.append(String.format("\\u%04x", (int) c));
            else builder.append(c);
        }
        return builder.append('"').toString();
    }
}
