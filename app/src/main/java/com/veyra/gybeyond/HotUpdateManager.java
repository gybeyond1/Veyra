package com.veyra.gybeyond;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.AtomicFile;
import android.util.Base64;
import android.webkit.WebResourceResponse;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.X509EncodedKeySpec;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Downloading never mutates a live session. Activation and recovery share one atomic state file. */
final class HotUpdateManager {
    static final String INDEX = "https://github.com/gybeyond1/HuangguoAPP-HotUpdates/releases/latest/download/hot-update.json";
    static final String UI_URL = "https://appassets.androidplatform.net/assets/app.html";
    static final int BRIDGE_VERSION = 1;
    private static final long BUNDLED_UI_REVISION = 999;
    private static HotUpdateManager singleton;
    private final Context context;
    private final File root;
    private final AtomicFile stateFile;
    private final SharedPreferences preferences;
    private final PublicKey publicKey;
    private final AtomicBoolean checking = new AtomicBoolean();

    static synchronized HotUpdateManager get(Context context) {
        if (singleton == null) {
            try { singleton = new HotUpdateManager(context); }
            catch (Exception error) { throw new IllegalStateException("无法初始化资源更新", error); }
        }
        return singleton;
    }

    HotUpdateManager(Context context) throws Exception { this(context, new File(context.getFilesDir(), "hot-updates")); }
    HotUpdateManager(Context context, File root) throws Exception {
        this.context = context.getApplicationContext();
        this.root = root;
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法建立资源目录");
        stateFile = new AtomicFile(new File(root, "state.json"));
        preferences = context.getSharedPreferences("hot-updates", Context.MODE_PRIVATE);
        String pem = new String(read(context.getAssets().open("hot-update-public.pem"), 8192), StandardCharsets.US_ASCII);
        byte[] encoded = Base64.decode(pem.replaceAll("-----[^-]+-----", "").replaceAll("\\s", ""), Base64.DEFAULT);
        publicKey = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(encoded));
    }

    static final class Session {
        final long revision;
        final String bootId = java.util.UUID.randomUUID().toString();
        final String version;
        final File directory;
        final SiteProfile site;
        final JSONObject theme;
        final boolean trial;
        Session(long revision, String version, File directory, SiteProfile site, JSONObject theme, boolean trial) {
            this.revision = revision; this.version = version; this.directory = directory;
            this.site = site; this.theme = theme; this.trial = trial;
        }
    }

    private JSONObject state() {
        try { return new JSONObject(new String(read(stateFile.openRead(), 64 * 1024), StandardCharsets.UTF_8)); }
        catch (Exception error) { return new JSONObject(); }
    }
    private void save(JSONObject data) throws Exception {
        FileOutputStream output = stateFile.startWrite();
        try { output.write(data.toString().getBytes(StandardCharsets.UTF_8)); stateFile.finishWrite(output); }
        catch (Exception error) { stateFile.failWrite(output); throw error; }
    }
    private File directory(long revision) { return new File(root, Long.toString(revision)); }
    private JSONObject metadata(long revision) throws Exception {
        return verifyEnvelope(read(new FileInputStream(new File(directory(revision), "envelope.json")), 256 * 1024));
    }
    private Session load(long revision, boolean trial) throws Exception {
        if (revision == 0) return new Session(0, "内置", null, new SiteProfile(context, null), new JSONObject(), false);
        JSONObject meta = metadata(revision);
        requireCompatible(meta);
        File dir = directory(revision);
        JSONObject site = json(new File(dir, "site.json"));
        JSONObject theme = json(new File(dir, "theme.json"));
        validateTheme(dir, theme);
        return new Session(revision, meta.getString("version"), dir, new SiteProfile(context, site), theme, trial);
    }
    synchronized SiteProfile currentSite() {
        try { return load(state().optLong("active"), false).site; }
        catch (Exception error) {
            try { return new SiteProfile(context, null); } catch (Exception fatal) { throw new IllegalStateException(fatal); }
        }
    }
    synchronized Session beginSession() {
        JSONObject state = state();
        try {
            if (state.optLong("trial") != 0) rollbackState(state, state.optLong("trial"));
            long pending = state.optLong("pending"), active = state.optLong("active");
            if (pending > active && pending != state.optLong("blocked")) {
                try { load(pending, true); }
                catch (Exception invalid) {
                    state.put("blocked", pending).put("pending", 0); save(state);
                    return load(active, false);
                }
                state.put("previous", active).put("active", pending).put("pending", 0).put("trial", pending);
                save(state);
                active = pending;
            }
            return load(active, state.optLong("trial") == active && active != 0);
        } catch (Exception error) {
            try {
                long failed = Math.max(state.optLong("active"), state.optLong("pending"));
                rollbackState(state, failed);
                return load(state.optLong("active"), false);
            } catch (Exception ignored) {
                try { save(new JSONObject().put("blocked", state.optLong("active"))); return load(0, false); }
                catch (Exception fatal) { throw new IllegalStateException(fatal); }
            }
        }
    }
    private void rollbackState(JSONObject state, long revision) throws Exception {
        long previous = state.optLong("previous");
        state.put("blocked", Math.max(revision, state.optLong("blocked"))).put("active", previous)
                .put("trial", 0).put("pending", 0).put("previous", 0);
        save(state);
    }
    synchronized void markHealthy(Session session) throws Exception {
        JSONObject state = state();
        if (session.revision == state.optLong("active") && state.optLong("trial") == session.revision) {
            state.put("trial", 0); save(state); prune(state);
        }
    }
    synchronized void rollback(Session session) throws Exception {
        JSONObject state = state();
        if (session.revision == state.optLong("active") && session.revision != 0) rollbackState(state, session.revision);
    }
    synchronized JSONObject status() throws Exception {
        JSONObject state = state();
        long active = state.optLong("active"), pending = state.optLong("pending");
        String version;
        try { version = active == 0 ? "内置" : metadata(active).getString("version"); }
        catch (Exception error) { version = "内置"; }
        return new JSONObject().put("revision", active).put("version", version)
                .put("pending", pending).put("checking", checking.get())
                .put("blocked", state.optLong("blocked")).put("bridgeVersion", BRIDGE_VERSION);
    }
    boolean hasPending() { synchronized (this) { return state().optLong("pending") > 0; } }

    JSONObject check(boolean force) throws Exception {
        if (INDEX.isEmpty()) return status().put("enabled", false);
        if (!checking.compareAndSet(false, true)) return status();
        try {
            long now = System.currentTimeMillis();
            int apkCode = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionCode;
            boolean apkChanged = preferences.getInt("lastApkVersionCode", 0) != apkCode;
            if (!force && !apkChanged && now - preferences.getLong("lastCheck", 0) < 5 * 60_000L) return status().put("checking", false);
            preferences.edit().putLong("lastCheck", now).putInt("lastApkVersionCode", apkCode).apply();
            byte[] envelope = download(INDEX, 256 * 1024);
            JSONObject meta = verifyEnvelope(envelope);
            requireCompatible(meta);
            long revision = meta.getLong("revision");
            synchronized (this) {
                JSONObject state = state();
                if (revision <= Math.max(Math.max(state.optLong("active"), state.optLong("pending")), state.optLong("blocked")))
                    return status().put("checking", false);
            }
            byte[] archive = download(meta.getString("url"), 12 * 1024 * 1024);
            stage(envelope, archive);
            return status().put("checking", false);
        } catch (java.io.IOException error) {
            // 更新源暂时不可用（如 GitHub Releases 未发布资源 404）：静默降级，继续用内置资源，
            // 不向用户弹"资源更新连接失败"红字；unavailable 标记供 UI 显示友好提示。
            return status().put("checking", false).put("unavailable", true);
        } finally { checking.set(false); }
    }

    JSONObject verifyEnvelope(byte[] bytes) throws Exception {
        JSONObject envelope = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        byte[] payload = Base64.decode(envelope.getString("payload"), Base64.DEFAULT);
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(publicKey); verifier.update(payload);
        if (!verifier.verify(Base64.decode(envelope.getString("signature"), Base64.DEFAULT)))
            throw new SecurityException("资源更新签名无效");
        JSONObject meta = new JSONObject(new String(payload, StandardCharsets.UTF_8));
        if (meta.getInt("schema") != 1 || meta.getLong("revision") < 1
                || !meta.getString("sha256").matches("[0-9a-f]{64}") || meta.getLong("size") <= 0
                || meta.getLong("size") > 12 * 1024 * 1024)
            throw new IllegalArgumentException("资源更新清单无效");
        new URL(meta.getString("url"));
        return meta;
    }
    private void requireCompatible(JSONObject meta) throws Exception {
        int code = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionCode;
        if (meta.optLong("revision") < BUNDLED_UI_REVISION || meta.optInt("contentModeVersion") != 1 || meta.getInt("minVersionCode") > code || meta.getInt("bridgeVersion") != BRIDGE_VERSION
                || meta.optInt("maxVersionCode", Integer.MAX_VALUE) < code)
            throw new IllegalArgumentException("资源包需要更新应用版本");
    }
    synchronized void stage(byte[] envelope, byte[] archive) throws Exception {
        JSONObject meta = verifyEnvelope(envelope); requireCompatible(meta);
        if (archive.length != meta.getLong("size") || !SiteProfile.hex(MessageDigest.getInstance("SHA-256")
                .digest(archive)).equals(meta.getString("sha256"))) throw new SecurityException("资源包校验失败");
        long revision = meta.getLong("revision");
        JSONObject state = state();
        if (revision <= Math.max(Math.max(state.optLong("active"), state.optLong("pending")), state.optLong("blocked"))) return;
        File stage = new File(root, revision + ".staging"), target = directory(revision);
        delete(stage); stage.mkdirs();
        try {
            long total = 0; int count = 0;
            Set<String> names = new HashSet<>();
            try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(archive))) {
                ZipEntry entry;
                while ((entry = zip.getNextEntry()) != null) {
                    if (++count > 512 || !names.add(entry.getName())) throw new IOException("资源包文件异常");
                    File file = inside(stage, entry.getName());
                    if (entry.isDirectory()) { file.mkdirs(); continue; }
                    if (!entry.getName().matches("(?:ui/|theme/).*|site\\.json|theme\\.json")
                            || !entry.getName().matches(".*\\.(html|css|js|svg|png|jpg|jpeg|webp|gif|json|woff|woff2|txt)$"))
                        throw new IOException("资源包含有不支持的文件");
                    file.getParentFile().mkdirs();
                    try (FileOutputStream output = new FileOutputStream(file)) {
                        byte[] buffer = new byte[8192]; int length;
                        while ((length = zip.read(buffer)) != -1) {
                            total += length;
                            if (total > 25 * 1024 * 1024) throw new IOException("资源包解压大小超限");
                            output.write(buffer, 0, length);
                        }
                    }
                }
            }
            new SiteProfile(context, json(new File(stage, "site.json")));
            validateTheme(stage, json(new File(stage, "theme.json")));
            File ui = new File(stage, "ui");
            if (!ui.exists() && !meta.optBoolean("resetUi", false) && state.optLong("active") != 0) {
                File previousUi = new File(directory(state.optLong("active")), "ui");
                if (previousUi.isDirectory()) copyUi(previousUi, ui, new long[]{total});
            }
            if (ui.isDirectory() && (!new File(ui, "app.html").isFile() || !new File(ui, "app.js").isFile()
                    || !new File(ui, "app.css").isFile())) throw new IOException("界面包缺少入口文件");
            try (FileOutputStream output = new FileOutputStream(new File(stage, "envelope.json"))) { output.write(envelope); }
            delete(target);
            if (!stage.renameTo(target)) throw new IOException("无法保存资源包");
            state.put("pending", revision); save(state);
        } catch (Exception error) { delete(stage); throw error; }
    }
    private void copyUi(File source, File target, long[] size) throws Exception {
        if (!source.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)
                || !target.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator))
            throw new IOException("界面目录越界");
        if (source.isDirectory()) {
            if (!target.isDirectory() && !target.mkdirs()) throw new IOException("无法保留界面目录");
            File[] files = source.listFiles();
            if (files != null) for (File file : files) copyUi(file, new File(target, file.getName()), size);
        } else {
            size[0] += source.length();
            if (size[0] > 25 * 1024 * 1024) throw new IOException("合并后资源包大小超限");
            try (InputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[8192]; int length;
                while ((length = input.read(buffer)) != -1) output.write(buffer, 0, length);
            }
        }
    }

    private void validateTheme(File dir, JSONObject theme) throws Exception {
        for (String name : new String[]{"startsAt", "endsAt"}) {
            if (!theme.isNull(name) && theme.has(name)) java.time.Instant.parse(theme.getString(name));
        }
        if (!theme.isNull("startsAt") && theme.has("startsAt") && !theme.isNull("endsAt") && theme.has("endsAt")
                && !java.time.Instant.parse(theme.getString("endsAt")).isAfter(java.time.Instant.parse(theme.getString("startsAt"))))
            throw new IllegalArgumentException("主题起止时间无效");
        if (theme.has("css")) requireThemeAsset(dir, theme.getString("css"));
        JSONObject background = theme.optJSONObject("background");
        if (background != null && background.has("asset")) requireThemeAsset(dir, background.getString("asset"));
        JSONObject dock = theme.optJSONObject("dock"), icons = dock == null ? null : dock.optJSONObject("icons");
        for (Iterator<String> keys = icons == null ? Collections.emptyIterator() : icons.keys(); keys.hasNext();)
            requireThemeAsset(dir, icons.getString(keys.next()));
    }
    private void requireThemeAsset(File dir, String path) throws Exception {
        if (!path.startsWith("theme/") || !inside(dir, path).isFile()) throw new IOException("主题资源不存在");
    }
    private void prune(JSONObject state) throws Exception {
        Set<String> keep = new HashSet<>(Arrays.asList(Long.toString(state.optLong("active")),
                Long.toString(state.optLong("previous")), Long.toString(state.optLong("pending"))));
        File[] dirs = root.listFiles();
        if (dirs != null) for (File dir : dirs)
            if (dir.isDirectory() && dir.getName().matches("[0-9]+(?:\\.staging)?") && !keep.contains(dir.getName())) delete(dir);
    }
    private void delete(File file) throws Exception {
        if (!file.exists()) return;
        if (!file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("资源目录越界");
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        if (!file.delete()) throw new IOException("无法清理资源目录");
    }
    static File inside(File base, String path) throws Exception {
        if (path.isEmpty() || path.startsWith("/") || path.contains("\\") || path.contains("%") || Arrays.asList(path.split("/")).contains("..")) throw new IOException("资源路径无效");
        File file = new File(base, path);
        if (!file.getCanonicalPath().startsWith(base.getCanonicalPath() + File.separator)) throw new IOException("资源路径越界");
        return file;
    }
    private static JSONObject json(File file) throws Exception {
        return new JSONObject(new String(read(new FileInputStream(file), 128 * 1024), StandardCharsets.UTF_8));
    }
    static byte[] read(InputStream stream, int maximum) throws IOException {
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > maximum) throw new IOException("资源文件大小超限");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }
    private static byte[] download(String address, int maximum) throws Exception {
        for (int redirect = 0; redirect < 6; redirect++) {
            URL url = new URL(address);
            if (!"https".equals(url.getProtocol())) throw new SecurityException("资源更新必须使用 HTTPS");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(15_000); connection.setReadTimeout(30_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("User-Agent", "HuangGuo-HotUpdate/1");
            try {
                int code = connection.getResponseCode();
                if (code >= 300 && code < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IOException("无效更新跳转");
                    address = new URL(url, location).toString(); continue;
                }
                if (code != 200) throw new IOException("资源更新连接失败（" + code + "）");
                return read(connection.getInputStream(), maximum);
            } finally { connection.disconnect(); }
        }
        throw new IOException("更新跳转次数超限");
    }

    WebResourceResponse resource(Session session, String path) {
        try {
            InputStream input;
            String mime;
            if ("runtime.js".equals(path)) {
                JSONObject data = new JSONObject().put("revision", session.revision).put("version", session.version).put("theme", session.theme).put("bootId", session.bootId);
                input = new ByteArrayInputStream(("window.HotRuntime=" + data + ";").getBytes(StandardCharsets.UTF_8));
                mime = "application/javascript";
            } else {
                File file = null;
                if (session.directory != null && !"hot-runtime.js".equals(path) && !"site-default.json".equals(path)
                        && !"hot-update-public.pem".equals(path)) {
                    file = inside(session.directory, path.startsWith("theme/") ? path : "ui/" + path);
                }
                inside(root, path); // Apply the same path policy to APK fallback assets.
                input = file != null && file.isFile() ? new FileInputStream(file) : context.getAssets().open(path);
                String extension = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
                switch (extension) {
                    case "html": mime = "text/html"; break;
                    case "js": mime = "application/javascript"; break;
                    case "css": mime = "text/css"; break;
                    case "svg": mime = "image/svg+xml"; break;
                    case "json": mime = "application/json"; break;
                    case "png": mime = "image/png"; break;
                    case "webp": mime = "image/webp"; break;
                    case "gif": mime = "image/gif"; break;
                    case "jpg": case "jpeg": mime = "image/jpeg"; break;
                    case "mp4": mime = "video/mp4"; break;
                    case "webm": mime = "video/webm"; break;
                    default: mime = "application/octet-stream";
                }
            }
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("X-Content-Type-Options", "nosniff");
            if ("text/html".equals(mime)) headers.put("Content-Security-Policy",
                    "default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
                            + "img-src 'self' data: https:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'");
            return new WebResourceResponse(mime, mime.startsWith("image/") ? null : "UTF-8", 200, "OK", headers, input);
        } catch (Exception error) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }
    }
    static boolean trusted(Uri uri) {
        return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
                && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getPath().startsWith("/assets/");
    }
}
