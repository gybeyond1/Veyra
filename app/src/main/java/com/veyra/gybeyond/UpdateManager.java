package com.veyra.gybeyond;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 更新检测：直连 GitHub Releases API（gybeyond1/Veyra），读 latest release 的
 * tag_name / body / assets[]，按渠道挑本设备能装的那个 APK。
 *
 * 渠道隔离：同一个 release 里既有 Veyra-x.y.z.apk（手机/平板）也有 Veyra-TV-x.y.z.apk（电视），
 * 两个包名不同、可以装在同一台设备上。以前这里取「assets 里第一个 .apk」，
 * 而 release 附件是按名字排序返回的，Veyra-TV-… 排在 Veyra-… 前面 ——
 * 结果手机端下下来的是电视包，本机版本号一直不涨，于是每次启动都提示更新，
 * 还凭空多出一个电视 App。现在三处一起卡：按包名判渠道挑附件、缓存记住渠道、
 * 下载完再校验 APK 的 packageName，装错直接丢弃。
 */
final class UpdateManager {
    private static final String RELEASE_API = "https://api.github.com/repos/gybeyond1/Veyra/releases/latest";
    private static final String RELEASE_BASE = "https://github.com/gybeyond1/Veyra/releases/download/";
    private static final Pattern VERSION = Pattern.compile("\\d+\\.\\d+\\.\\d+");
    /** 附件名里单独出现的 tv 记号：Veyra-TV-0.24.3.apk / veyra.tv.apk / veyra_tv_x.apk 都算。 */
    private static final Pattern TV_MARK = Pattern.compile("(?i)(^|[-_.])tv([-_.]|$)");
    private static final long AUTO_INTERVAL_MS = 12 * 60 * 60 * 1000L;

    interface Progress { void onPercent(int percent); }

    private final Context context;
    private final SharedPreferences preferences;
    /** 电视轻量包为 true，手机/平板包为 false；共用这份代码，只在这里分道。 */
    private final boolean tvBuild;
    private Candidate candidate;
    private boolean downloading;

    private static final class Candidate {
        String version;
        String url;
        String digest;
        long size;
        String notes;
        /** 包从哪儿来：server（自己的后端，国内满速）/ github（兜底）。 */
        String source = "github";
    }

    UpdateManager(Context context) {
        this.context = context.getApplicationContext();
        preferences = this.context.getSharedPreferences("updates", Context.MODE_PRIVATE);
        boolean lite = false;
        try {
            lite = this.context.getResources().getBoolean(R.bool.veyra_lite);
        } catch (Exception ignored) { }
        // 兜底：就算资源没读到，电视包包名一定带 .tv 后缀
        tvBuild = lite || this.context.getPackageName().endsWith(".tv");
    }

    private String channel() { return tvBuild ? "tv" : "mobile"; }

    /** 附件名是不是电视包：名字里单独出现 tv 记号才算。 */
    static boolean isTvAsset(String assetName) {
        return TV_MARK.matcher(assetName).find();
    }

    /** 附件名是否属于本渠道：带 tv 记号的只给电视，不带的只给手机。 */
    private boolean matchesChannel(String assetName) {
        return isTvAsset(assetName) == tvBuild;
    }

    synchronized JSONObject cached() throws Exception {
        String saved = preferences.getString("available_manifest", null);
        if (saved == null) return status("none");
        try {
            JSONObject manifest = new JSONObject(saved);
            // 老缓存没有渠道字段（或来自另一渠道）：直接作废，免得手机继续拿电视包
            if (!channel().equals(manifest.optString("channel"))) {
                clearCandidate();
                return status("none");
            }
            // 换过服务器：缓存的地址还指着旧机器，作废重查（否则会去旧地址下、或者一直下不动）
            if ("server".equals(manifest.optString("source")) && !isAllowedUrl(manifest.optString("url"))) {
                clearCandidate();
                return status("none");
            }
            PackageInfo installed = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            if (isNewer(manifest.optString("versionName"), installed.versionName)) {
                candidate = candidateFrom(manifest);
                return availableStatus(candidate, installed.versionName);
            }
            clearCandidate();
            return status("none");
        } catch (Exception error) {
            clearCandidate();
            return status("none");
        }
    }

    private void clearCandidate() {
        candidate = null;
        preferences.edit().remove("available_manifest").apply();
    }

    /** 语义化版本比较：remote 比 local 新返回 true。 */
    private static boolean isNewer(String remote, String local) {
        int[] r = parseVersion(remote), l = parseVersion(local);
        if (r == null || l == null) return false;
        for (int i = 0; i < 3; i++) {
            if (r[i] != l[i]) return r[i] > l[i];
        }
        return false;
    }

    private static int[] parseVersion(String v) {
        if (v == null) return null;
        String s = v.trim().replaceFirst("^[vV]", "");
        String[] parts = s.split("\\.");
        if (parts.length < 3) return null;
        try {
            return new int[]{
                    Integer.parseInt(parts[0]),
                    Integer.parseInt(parts[1]),
                    Integer.parseInt(parts[2])
            };
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private Candidate candidateFrom(JSONObject manifest) throws Exception {
        String version = manifest.optString("versionName");
        String tag = manifest.optString("tag");
        String apk = manifest.optString("apk");
        String sha256 = manifest.optString("sha256");
        if (!VERSION.matcher(version).matches() || !tag.equals("v" + version)
                || !apk.endsWith(".apk") || !matchesChannel(apk)) {
            throw new IllegalStateException("发布信息格式有误");
        }
        Candidate result = new Candidate();
        result.version = version;
        result.source = manifest.optString("source", "github");
        // server 来源：manifest 里存的是后端的绝对地址（同一台机器，速度取决于内网/上行）
        // github 来源：直连 GitHub（跟随 302 到 objects CDN）
        String saved = manifest.optString("url", "");
        result.url = isAllowedUrl(saved) ? saved : RELEASE_BASE + tag + "/" + apk;
        result.digest = sha256.matches("[0-9a-fA-F]{64}") ? "sha256:" + sha256 : "";
        result.size = manifest.optLong("size");
        result.notes = manifest.optString("notes", "");
        return result;
    }

    private static JSONObject availableStatus(Candidate value, String localVersion) throws Exception {
        return status("available").put("version", value.version).put("currentVersion", localVersion)
                .put("notes", value.notes).put("size", value.size);
    }

    synchronized JSONObject check(boolean manual) throws Exception {
        long now = System.currentTimeMillis();
        // 手动检查不设次数限制（旧版「1 小时最多 5 次」会在调试时被卡住）；
        // 只有自动检查才走 12 小时间隔，避免每次冷启动都打 GitHub API。
        if (!manual) {
            long last = preferences.getLong("last_auto_check", 0);
            if (last > 0 && now >= last && now - last < AUTO_INTERVAL_MS) return cached();
            preferences.edit().putLong("last_auto_check", now).apply();
        }

        PackageInfo installed = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        String localVersion = installed.versionName;

        // 手动点「检查更新」= 顺便让后端当场查一次、把包下下来（优先本渠道）。
        // 不然后端还是十分钟一轮的节奏，发版后要干等十几分钟才有包。
        if (manual) triggerServerCheck();

        // 先问自己的后端：它已经把 APK 缓存在本地了，从它那里下比让手机直连 GitHub 稳得多。
        // 后端没配置 / 连不上 / 还没拉到包，都安静地回退 GitHub —— 行为跟以前一样。
        JSONObject viaServer = tryServer(localVersion);
        // 后端已经知道有新版、包还没下完：等几秒再看。立刻退回 GitHub 直连是最慢的一条路。
        for (int i = 0; manual && i < 5 && viaServer != null
                && "preparing".equals(viaServer.optString("status")); i++) {
            try { Thread.sleep(1200); } catch (InterruptedException stop) { break; }
            viaServer = tryServer(localVersion);
        }
        if (viaServer != null) {
            String serverState = viaServer.optString("status");
            if ("current".equals(serverState)) {
                clearCandidate();
                return status("current").put("version", localVersion);
            }
            if ("available".equals(serverState)) {
                JSONObject manifest = manifestOfServer(viaServer);
                if (manifest != null) {
                    candidate = candidateFrom(manifest);
                    preferences.edit().putString("available_manifest", manifest.toString()).apply();
                    return availableStatus(candidate, localVersion);
                }
            }
            // none / preparing：后端还没有包，落下去走 GitHub
        }

        JSONObject release = fetchRelease();
        if (manual) preferences.edit().putLong("last_auto_check", now).apply();
        if (release == null) {
            clearCandidate();
            return status("unpublished");
        }
        String tag = release.optString("tag_name", "");
        String version = tag.replaceFirst("^[vV]", "");
        JSONObject asset = pickAsset(release);
        if (asset == null) {
            // 新版发布了但还没打本渠道的包：不能说「已经是最新」，得让界面讲清楚
            clearCandidate();
            return status("channel-missing").put("channel", channel()).put("version", version);
        }
        if (!isNewer(version, localVersion)) {
            clearCandidate();
            return status("current").put("version", localVersion);
        }
        JSONObject manifest = manifestOf(release, asset);
        candidate = candidateFrom(manifest);
        preferences.edit().putString("available_manifest", manifest.toString()).apply();
        return availableStatus(candidate, localVersion);
    }

    synchronized File download(Progress progress) throws Exception {
        if (downloading) throw new IllegalStateException("更新包正在下载");
        if (candidate == null) throw new IllegalStateException("请先检查更新");
        // 只允许 GitHub 官方和当前后端两种来源，别的地址一律不认
        if (!isAllowedUrl(candidate.url)) throw new IllegalStateException("更新包地址无效");
        downloading = true;
        try {
            File directory = new File(context.getCacheDir(), "updates");
            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建下载目录");
            dropOtherChannelFiles(directory);
            String name = candidate.url.substring(candidate.url.lastIndexOf('/') + 1);
            File apk = new File(directory, name);
            // 已经下好的包直接复用：有 sha256 就比 sha256，没有（后端没给）就比大小
            if (apk.isFile() && (candidate.digest.isEmpty()
                    ? (candidate.size <= 0 || apk.length() == candidate.size)
                    : matchesDigest(apk, candidate.digest))) {
                verifyPackage(apk);
                progress.onPercent(100);
                return apk;
            }
            // .part 按来源分开：GitHub 下了一半再换后端，两边不会互相污染
            File partial = new File(directory, name + "." + candidate.source + ".part");
            // 最多两次尝试：第一次中断后保留 .part，第二次走 Range 续传；仍失败则保留 .part，
            // 下次点「重试下载」可从断点继续，不再每次从头下。
            Exception lastError = null;
            for (int attempt = 0; attempt < 2; attempt++) {
                try {
                    File done = downloadAttempt(candidate.url, candidate.size, candidate.digest, partial, apk, progress);
                    verifyPackage(done);
                    return done;
                } catch (Exception error) {
                    lastError = error;
                    // 校验失败说明已下载内容本身就是坏的，续传无意义，清掉从头下；
                    // 「下载不完整」/网络中断则保留 .part 供续传。
                    if (error instanceof IllegalStateException && error.getMessage() != null
                            && error.getMessage().contains("校验失败")) {
                        if (partial.exists()) partial.delete();
                    }
                    // 后端这条腿断了（重启 / 被别的设备占满上行）：换 GitHub 再试一次，
                    // 别让用户只能干瞪眼点重试。两边 .part 各自独立，互不污染。
                    if (attempt == 0 && "server".equals(candidate.source)) {
                        candidate.source = "github";
                        candidate.url = RELEASE_BASE + "v" + candidate.version + "/" + name;
                        partial = new File(directory, name + ".github.part");
                    }
                    progress.onPercent(0);
                }
            }
            throw lastError != null ? lastError : new IllegalStateException("下载失败，请重试");
        } finally {
            downloading = false;
        }
    }

    /** 装之前先看包里的 packageName：手机不装电视包，电视不装手机包。 */
    private void verifyPackage(File apk) {
        String expected = context.getPackageName();
        PackageInfo info = context.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
        if (info == null) {
            apk.delete();
            throw new IllegalStateException("安装包无法解析，请重新下载");
        }
        if (!expected.equals(info.packageName)) {
            apk.delete();
            throw new IllegalStateException(tvBuild ? "下载到的是手机版安装包，已丢弃" : "下载到的是电视版安装包，已丢弃");
        }
    }

    /** 清掉缓存目录里另一个渠道的旧包（换包名后残留的电视包很占地方）。 */
    private void dropOtherChannelFiles(File directory) {
        File[] files = directory.listFiles();
        if (files == null) return;
        for (File file : files) {
            String name = file.getName();
            if (!name.endsWith(".apk") && !name.endsWith(".part")) continue;
            if (!matchesChannel(name)) file.delete();
        }
    }

    /** 单次下载尝试：.part 存在时带 Range 续传（服务器支持则 206），完成后校验大小 + SHA-256。 */
    private File downloadAttempt(String url, long expectedSize, String digest, File partial, File apk, Progress progress) throws Exception {
        long resume = partial.isFile() ? partial.length() : 0;
        HttpURLConnection connection = open(url, resume);
        try {
            int code = connection.getResponseCode();
            boolean resumed = resume > 0 && code == HttpURLConnection.HTTP_PARTIAL;
            long downloaded = resumed ? resume : 0;
            if (resume > 0 && !resumed) partial.delete();   // 服务器不认 Range：从头全量
            long total = expectedSize > 0 ? expectedSize : connection.getContentLengthLong();
            try (InputStream input = connection.getInputStream();
                 FileOutputStream output = new FileOutputStream(partial, resumed)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                int previous = -1;
                while ((count = input.read(buffer)) != -1) {
                    output.write(buffer, 0, count);
                    downloaded += count;
                    int percent = total > 0 ? (int) Math.min(99, downloaded * 100 / total) : 0;
                    if (percent != previous) { progress.onPercent(percent); previous = percent; }
                }
            }
            if (expectedSize > 0 && downloaded != expectedSize) throw new IllegalStateException("更新包下载不完整，请重试");
            if (!digest.isEmpty() && !matchesDigest(partial, digest)) throw new IllegalStateException("更新包校验失败，请重试");
            if (apk.exists() && !apk.delete()) throw new IllegalStateException("无法替换旧下载包");
            if (!partial.renameTo(apk)) throw new IllegalStateException("无法保存更新包");
            progress.onPercent(100);
            return apk;
        } finally {
            connection.disconnect();
        }
    }

    private static HttpURLConnection open(String address, long from) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(60_000);
        connection.setRequestProperty("User-Agent", "ChengZi-Android-Updater");
        connection.setRequestProperty("Accept", "application/json");
        if (from > 0) connection.setRequestProperty("Range", "bytes=" + from + "-");
        int code = connection.getResponseCode();
        if ((code < 200 || code >= 300) && code != HttpURLConnection.HTTP_PARTIAL) {
            connection.disconnect();
            throw new IllegalStateException("GitHub 请求失败（" + code + "）");
        }
        return connection;
    }

    private static JSONObject status(String value) throws Exception { return new JSONObject().put("status", value); }

    /** 从 release 的 assets 里挑本渠道的 APK；没有就返回 null。 */
    private JSONObject pickAsset(JSONObject release) {
        return pickAsset(release.optJSONArray("assets"), tvBuild);
    }

    /**
     * 附件挑拣的唯一实现：只认 .apk，且名字的 tv 记号要和渠道一致。
     * release 的 assets 是按名字排序返回的（Veyra-TV-… 排在 Veyra-… 前面），
     * 所以绝不能「取第一个」；这里逐个比对，谁也不许串台。
     */
    static JSONObject pickAsset(JSONArray assets, boolean tvBuild) {
        if (assets == null) return null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.optJSONObject(i);
            if (asset == null) continue;
            String name = asset.optString("name", "");
            if (!name.toLowerCase(Locale.ROOT).endsWith(".apk")) continue;
            if (isTvAsset(name) != tvBuild) continue;
            return asset;
        }
        return null;
    }

    /**
     * 后端地址是否可信：只认「GitHub 官方」和「当前配置的后端」两种前缀。
     * 这样即使用户把服务器地址改成别人分享的机器，也只会去那台机器下包，不会被执行任意 URL。
     */
    private boolean isAllowedUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        if (url.startsWith(RELEASE_BASE)) return true;
        String base = ServerConfig.get(context);
        return !base.isEmpty() && url.startsWith(base);
    }

    /**
     * 通知后端「现在就去查一次，有新版顺手把包下下来」，优先本渠道（手机包 / 电视包）。
     * 尽力而为：没配后端、超时、报错都直接忽略，不影响后面照常判断。
     */
    private void triggerServerCheck() {
        String base = ServerConfig.get(context);
        if (base == null || base.isEmpty()) return;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(base + "api/update/check?channel=" + channel()).openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(0);
            connection.setConnectTimeout(3_000);
            connection.setReadTimeout(3_000);
            connection.setRequestProperty("User-Agent", "ChengZi-Android-Updater");
            connection.setRequestProperty("Accept", "application/json");
            connection.getOutputStream().close();
            connection.getResponseCode();
        } catch (Exception ignored) {
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * 问后端有没有新版本。返回 null = 没配置/连不上（交给 GitHub 兜底）。
     *
     * 超时压得很短（连 4s / 读 6s）：后端通常就在身边，慢到这个程度说明它不可用，
     * 与其让用户干等，不如立刻回退。真正下包时用的是 15s/60s。
     */
    private JSONObject tryServer(String localVersion) {
        String base = ServerConfig.get(context);
        if (base == null || base.isEmpty()) return null;
        HttpURLConnection connection = null;
        try {
            String query = base + "api/app-update?channel=" + channel()
                    + "&current=" + java.net.URLEncoder.encode(localVersion == null ? "" : localVersion, "UTF-8");
            connection = (HttpURLConnection) new URL(query).openConnection();
            connection.setConnectTimeout(4_000);
            connection.setReadTimeout(6_000);
            connection.setRequestProperty("User-Agent", "ChengZi-Android-Updater");
            connection.setRequestProperty("Accept", "application/json");
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) return null;
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            try (InputStream stream = connection.getInputStream()) {
                byte[] buffer = new byte[16 * 1024];
                int count;
                while ((count = stream.read(buffer)) != -1) {
                    out.write(buffer, 0, count);
                    if (out.size() > 256 * 1024) return null;
                }
            }
            return new JSONObject(new String(out.toByteArray(), java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** 把后端返回的清单转成内部格式；字段不对就返回 null，落回 GitHub。 */
    private JSONObject manifestOfServer(JSONObject payload) {
        try {
            String version = payload.optString("version", "").trim();
            if (!VERSION.matcher(version).matches()) return null;
            String path = payload.optString("url", "");
            if (path.isEmpty()) return null;
            String apk = path.substring(path.lastIndexOf('/') + 1);
            if (!apk.toLowerCase(Locale.ROOT).endsWith(".apk") || !matchesChannel(apk)) return null;
            String absolute = path.startsWith("http")
                    ? path
                    : ServerConfig.get(context) + path.replaceFirst("^/", "");
            if (!isAllowedUrl(absolute)) return null;
            JSONObject manifest = new JSONObject();
            manifest.put("versionName", version);
            manifest.put("tag", "v" + version);
            manifest.put("apk", apk);
            manifest.put("sha256", payload.optString("sha256", ""));
            manifest.put("size", payload.optLong("size", 0));
            manifest.put("notes", payload.optString("notes", ""));
            manifest.put("channel", channel());
            manifest.put("source", "server");
            manifest.put("url", absolute);
            return manifest;
        } catch (Exception error) {
            return null;
        }
    }

    private JSONObject manifestOf(JSONObject release, JSONObject asset) throws Exception {
        String tag = release.optString("tag_name", "");
        String digest = asset.optString("digest", "").replaceFirst("^sha256:", "").trim();
        JSONObject manifest = new JSONObject();
        manifest.put("versionName", tag.replaceFirst("^[vV]", ""));
        manifest.put("tag", tag);
        manifest.put("apk", asset.optString("name", ""));
        manifest.put("size", asset.optLong("size", 0));
        manifest.put("notes", release.optString("body", ""));
        manifest.put("sha256", digest);
        manifest.put("channel", channel());
        manifest.put("source", "github");
        return manifest;
    }

    /** 拉取 GitHub Releases API latest；404 表示还没发过版。 */
    private static JSONObject fetchRelease() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(RELEASE_API).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setRequestProperty("User-Agent", "ChengZi-Android-Updater");
        connection.setRequestProperty("Accept", "application/vnd.github+json");
        int code = connection.getResponseCode();
        if (code == 404) { connection.disconnect(); return null; }
        if (code < 200 || code >= 300) {
            connection.disconnect();
            throw new IllegalStateException("GitHub 请求失败（" + code + "）");
        }
        try (InputStream stream = connection.getInputStream()) {
            byte[] bytes = new byte[256 * 1024];
            int length = 0;
            while (true) {
                int count = stream.read(bytes, length, bytes.length - length);
                if (count < 0) break;
                length += count;
                if (length == bytes.length) throw new IllegalStateException("发布列表过大");
            }
            return new JSONObject(new String(bytes, 0, length, java.nio.charset.StandardCharsets.UTF_8));
        } finally {
            connection.disconnect();
        }
    }

    private static boolean matchesDigest(File file, String expected) throws Exception {
        MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) sha256.update(buffer, 0, count);
        }
        StringBuilder actual = new StringBuilder("sha256:");
        for (byte value : sha256.digest()) actual.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return actual.toString().equalsIgnoreCase(expected);
    }
}
