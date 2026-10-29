package com.veyra.gybeyond;

import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.hongguotv.core.RemoteVideo;
import com.hongguotv.core.StreamInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import okhttp3.OkHttpClient;

/**
 * 手机本地下载 + 多集合并。
 *
 * 下载：红果为 CENC 加密流，用 third_party 的 RemoteVideo（Range 拉流 + 解密）写出明文分集；
 *       黄果为普通 HTTPS 直链，直接流式下载。
 * 合并：MediaExtractor + MediaMuxer（分集为同编码同参数的独立 mp4 时 sample 级拷贝合并）：
 *       第 1 集从头 addTrack，后续集视频轨 seekTo(0, SEEK_TO_CLOSEST_SYNC) 定位关键帧，
 *       PTS 平移 = rawPts - basePts + 前序累计时长；成功后删单集，失败删半成品。
 * 落盘：合并产物先写 app 专属目录，完成后经 MediaStore 导出到公共 Download（Android 10+）。
 */
final class DownloadManager {
    private static DownloadManager instance;

    static synchronized DownloadManager get(Context context) {
        if (instance == null) instance = new DownloadManager(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final OkHttpClient http;
    private final ExecutorService pool = Executors.newFixedThreadPool(2);
    private final List<Task> tasks = Collections.synchronizedList(new ArrayList<>());

    private DownloadManager(Context context) {
        this.context = context;
        this.http = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .build();
        persistLoaded = loadPersisted();
        sweepOrphans();
    }

    /** loadPersisted 是否成功恢复（false = 记录文件损坏，孤儿清理被跳过） */
    private boolean persistLoaded;

    static final class Task {
        final String id;
        final String source;   // hongguo | huangguo
        final String title;
        volatile String cover = "";   // 封面地址：我的下载按观看历史排版展示
        final JSONArray episodes;   // [{index,url,key?}]
        volatile String status = "running";   // running | ready(已下载待合并) | done | failed | canceled
        volatile int doneCount = 0;
        volatile int totalCount = 0;
        volatile int percent = 0;
        volatile String detail = "";
        volatile String output = "";
        volatile String error = "";
        volatile String debug = "";   // 合并/下载详细排查日志（多行，UI 换行展示）
        volatile String nasTaskId = "";   // 转发模式：NAS 后端任务 id
        /** 调试模式（私密模式专用）：只把 TS 分片+KEY+playlist 下全并打包导出，**不做自动合并**。
         *  用来取「单集黑屏」那集的原始素材，交给开发者离线分析（产物在 Download/Veyra/剧名/第NN集_调试包.zip）。 */
        volatile boolean keepRaw = false;
        final long createdAt = System.currentTimeMillis();
        volatile boolean canceled = false;

        Task(String id, String source, String title, JSONArray episodes) {
            this.id = id; this.source = source; this.title = title; this.episodes = episodes;
            this.totalCount = episodes.length();
        }

        JSONObject snapshot() {
            try {
                return new JSONObject()
                        .put("id", id).put("source", source).put("title", title).put("cover", cover)
                        .put("status", status).put("doneCount", doneCount).put("totalCount", totalCount)
                        .put("percent", percent).put("detail", detail)
                        .put("nasTaskId", nasTaskId).put("keepRaw", keepRaw)
                        .put("output", output).put("error", error).put("debug", debug).put("createdAt", createdAt);
            } catch (Exception e) { return new JSONObject(); }
        }
    }

    // ---- 任务持久化（进程重启后手机下载记录不丢）----
    private void persist() {
        try {
            JSONArray arr = new JSONArray();
            synchronized (tasks) {
                for (Task t : tasks) {
                    arr.put(new JSONObject()
                            .put("id", t.id).put("source", t.source).put("title", t.title).put("cover", t.cover)
                            .put("status", t.status).put("percent", t.percent)
                            .put("doneCount", t.doneCount).put("totalCount", t.totalCount)
                            .put("detail", t.detail).put("output", t.output).put("error", t.error).put("debug", t.debug)
                            .put("nasTaskId", t.nasTaskId)
                            .put("keepRaw", t.keepRaw)
                            .put("episodes", t.episodes)
                            .put("createdAt", t.createdAt));
                }
            }
            // 原子写：先写临时文件再 rename。此前直接覆盖 downloads.json，
            // 写到一半进程被杀（用户退出/系统回收）会留下半截 JSON，下次启动
            // loadPersisted 解析失败 → 任务记录全部丢失 → 孤儿清理把已下载的文件当
            // 无主目录连锅端 —— 就是「退出重开，下载的文件自动没了」的根因。
            File tmp = new File(context.getFilesDir(), "downloads.json.tmp");
            File dst = new File(context.getFilesDir(), "downloads.json");
            try (FileOutputStream fos = new FileOutputStream(tmp)) {
                fos.write(arr.toString().getBytes("UTF-8"));
                fos.getFD().sync();
            }
            try {
                java.nio.file.Files.move(tmp.toPath(), dst.toPath(),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                        java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            } catch (Exception atomicFailure) {
                // 同一 filesDir 内的普通 move 仍由系统替换目录项；绝不直接截断旧 JSON。
                // 两次都失败时保留完整 tmp 与旧 dst，下次启动可恢复，而不是留下半截文件。
                java.nio.file.Files.move(tmp.toPath(), dst.toPath(),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (Exception ignored) { }
    }

    /** @return true = 成功恢复（或本就没有持久化文件）；false = 文件存在但解析失败（已备份，绝不能做孤儿清理） */
    private boolean loadPersisted() {
        File f = new File(context.getFilesDir(), "downloads.json");
        if (!f.exists()) return true;
        try {
            String s = new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8");
            JSONArray arr = new JSONArray(s);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Task t = new Task(o.optString("id"), o.optString("source"), o.optString("title"), new JSONArray());
                t.cover = o.optString("cover", "");
                boolean wasRunning = "running".equals(o.optString("status"));
                t.status = wasRunning ? "failed" : o.optString("status");
                t.detail = wasRunning ? "已中断（应用重启）" : o.optString("detail", "");
                t.error = wasRunning ? "已中断（应用重启）" : o.optString("error", "");
                t.percent = o.optInt("percent", 0);
                t.doneCount = o.optInt("doneCount", 0);
                t.totalCount = Math.max(o.optInt("totalCount", 0), 1);
                t.output = o.optString("output", "");
                t.debug = o.optString("debug", "");
                t.nasTaskId = o.optString("nasTaskId", "");
                t.keepRaw = o.optBoolean("keepRaw", false);
                // 恢复分集列表（episodes 为 final JSONArray，用 put 拷贝），否则重试恢复的任务分集数=0
                JSONArray saved = o.optJSONArray("episodes");
                if (saved != null) {
                    for (int k = 0; k < saved.length(); k++) t.episodes.put(saved.optJSONObject(k));
                }
                tasks.add(t);
            }
            return true;
        } catch (Exception e) {
            // 记录文件损坏：备份现场，绝不能往下走孤儿清理（否则上面所有已下载文件会被当成无主目录全删）
            try {
                java.nio.file.Files.copy(f.toPath(),
                        new File(context.getFilesDir(), "downloads.json.corrupt").toPath(),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            } catch (Exception ignored) { }
            return false;
        }
    }
    /** 孤儿目录清理：downloads/ 与公共 Download/Veyra 下已无任务记录的历史目录
     *  （旧版 delete 只删产物不删分集，遗留大量 ep*.mp4 密文分集 + seg_v6 规范化缓存 + merged.mp4，
     *  导致存储膨胀）一次性删除。
     *  安全阀：仅当任务记录恢复成功且列表非空时才执行 —— 记录为空多半意味着 downloads.json
     *  丢失/损坏，此时目录里的文件是用户仅存的下载成果，一删就是「重开后下载全没了」。 */
    private void sweepOrphans() {
        if (!persistLoaded || tasks.isEmpty()) return;
        try {
            File base = new File(context.getFilesDir(), "downloads");
            File basePub = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Veyra");
            File[] bases = { base, basePub };
            for (File base2 : bases) {
                File[] dirs = base2.listFiles();
                if (dirs == null) continue;
                HashSet<String> alive = new HashSet<>();
                synchronized (tasks) { for (Task t : tasks) alive.add(t.id); }
                boolean isPublic = base2.equals(basePub);
                for (File d : dirs) {
                    if (!d.isDirectory()) continue;
                    String name = d.getName();
                    String id2;
                    if (isPublic) {
                        // 公共目录里只有 dl_<id> 这种「任务工作目录」参与孤儿判定。
                        // 以剧名命名的目录（Download/Veyra/<剧名>/）是用户最终的成品下载，
                        // 里面装着转码分集与合并整集，名字不等于任务 id —— 绝不能当孤儿删，
                        // 否则「退出重开，连已合并的整集一起没了」。
                        if (!name.startsWith("dl_")) continue;
                        id2 = name.substring(3);
                    } else {
                        // 私有 downloads/<id> 直接用任务 id 命名
                        id2 = name;
                    }
                    if (!alive.contains(id2)) deleteRecursive(d);
                }
            }
        } catch (Exception ignored) { }
        sweepMergedResidue();
    }

    /** 清理历史残留（启动时跑一次）：
     *  - 剧集目录里已有正式产物「剧名.mp4」的，把同目录的分集中间产物（ep001.mp4 / 第01集.mp4）
     *    删掉，避免文件管理器里同一集出现两个文件；
     *  - Download/Veyra 下已无任务记录且为空的 dl_xxx 任务目录删掉（0 项的空文件夹）。
     *  判据很保守：没有正式产物就一律不动（合并失败时那些分集是用户唯一的观看文件）。 */
    private void sweepMergedResidue() {
        try {
            File basePub = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Veyra");
            File[] dirs = basePub.listFiles();
            if (dirs == null) return;
            for (File d : dirs) {
                if (!d.isDirectory()) continue;
                String dn = d.getName();
                if (dn.startsWith("dl_")) {
                    String id2 = dn.substring(3);
                    Task found = null;
                    synchronized (tasks) { for (Task t : tasks) if (id2.equals(t.id)) { found = t; break; } }
                    // 仍在下载/合并中的任务不动（目录可能刚建还是空的）
                    if (found != null && !"done".equals(found.status) && !"failed".equals(found.status)) continue;
                    File[] kids = d.listFiles();
                    boolean hasContent = kids != null && kids.length > 0;
                    if (hasContent) {
                        // 任务已完成且剧集目录里已有正式成品 → 这个任务目录里只剩重复的分集与临时片。
                        // 用户实测反馈：「合并前 Download/Veyra 下会多出一个和自己剧名文件夹内容一样的
                        // dl_xxx」，就是这个残留（新版本导出后已当场删除中间产物，这里清历史遗留）。
                        String title = found != null ? found.title : null;
                        boolean finished = found != null && "done".equals(found.status);
                        if (finished && title != null) {
                            File edir = episodeDir(title);
                            File official = new File(edir, title.replaceAll("[\\\\/:*?\"<>|]", "_") + ".mp4");
                            if (official.exists() && official.length() > 0) {
                                deleteRecursive(d);
                                continue;
                            }
                        }
                        continue;   // 有内容（失败重试还要的 ts / 还没合并）：保留
                    }
                    d.delete();
                    continue;
                }
                // 历史遗留的名字漂移：「第01集_1793034343293.mp4」→「第01集.mp4」，
                // 「剧名_1793032838265.mp4」→ 有正式名就删重复、没有就正名回来。
                normalizeEpisodeNames(d);
                fixDriftName(d, dn);
                File official = new File(d, dn + ".mp4");
                if (!(official.exists() && official.length() > 0)) continue;
                File[] kids = d.listFiles();
                if (kids == null) continue;
                for (File f : kids) {
                    if (!f.isFile() || !isEpisodeArtifact(f.getName())) continue;
                    f.delete();
                    deletePublicFile(Environment.DIRECTORY_DOWNLOADS + "/Veyra/" + dn, f.getName());
                }
            }
        } catch (Exception ignored) { }
    }

    /** 修复「剧名_1793032838265.mp4」这种被 MediaStore 去重改名的产物：
     *  目录里若已有正式「剧名.mp4」→ 带后缀的是重复文件，删掉；没有 → 把它正名回「剧名.mp4」。 */
    private void fixDriftName(File d, String base) {
        try {
            File official = new File(d, base + ".mp4");
            boolean hasOfficial = official.exists() && official.length() > 0;
            File[] kids = d.listFiles();
            if (kids == null) return;
            java.util.regex.Pattern drift = driftPattern(base + ".mp4");
            String rel = Environment.DIRECTORY_DOWNLOADS + "/Veyra/" + base;
            for (File f : kids) {
                if (!f.isFile() || !drift.matcher(f.getName()).matches()) continue;
                if (hasOfficial) {          // 已有正式产物：带后缀的是重复文件
                    f.delete();
                    deletePublicFile(rel, f.getName());
                    continue;
                }
                if (Build.VERSION.SDK_INT >= 29 && renamePublicEntry(rel, f.getName(), base + ".mp4")) {
                    hasOfficial = true;
                    continue;
                }
                if (f.renameTo(official)) {  // MediaStore 改不动就退回 File 改名，再补一次扫描
                    deletePublicFile(rel, f.getName());
                    MediaScannerConnection.scanFile(context, new String[]{official.getAbsolutePath()},
                            new String[]{"video/mp4"}, null);
                    hasOfficial = true;
                }
            }
        } catch (Exception ignored) { }
    }

    /** 走 MediaStore 删公共 Downloads 里的单个条目（File.delete 在部分 ROM 上会静默失败）。 */
    private void deletePublicFile(String rel, String name) {
        if (Build.VERSION.SDK_INT < 29) return;
        try {
            String[] rels = relCandidates(rel);
            try (android.database.Cursor c = context.getContentResolver().query(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Downloads._ID},
                    MediaStore.Downloads.RELATIVE_PATH + " IN (?,?) AND "
                            + MediaStore.Downloads.DISPLAY_NAME + "=?",
                    new String[]{rels[0], rels[1], name}, null)) {
                if (c != null) while (c.moveToNext()) {
                    try {
                        context.getContentResolver().delete(ContentUris.withAppendedId(
                                MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0)), null, null);
                    } catch (Exception ignored) { }
                }
            }
        } catch (Exception ignored) { }
    }

    // ---- 对外 API（供 MainActivity dispatch 调用）----
    JSONObject start(String source, String title, JSONArray episodes) throws Exception {
        return start(source, title, episodes, false, "");
    }

    /** @param keepRaw 调试模式：保留 TS/KEY 并打包导出，不自动合并（私密模式「下载到手机（调试）」）。 */
    JSONObject start(String source, String title, JSONArray episodes, boolean keepRaw) throws Exception {
        return start(source, title, episodes, keepRaw, "");
    }

    JSONObject start(String source, String title, JSONArray episodes, boolean keepRaw, String cover) throws Exception {
        if (!"hongguo".equals(source) && !"huangguo".equals(source)) throw new IllegalArgumentException("无效来源");
        if (episodes == null || episodes.length() == 0) throw new IllegalArgumentException("没有可下载的分集");
        for (int i = 0; i < episodes.length(); i++) {
            JSONObject ep = episodes.optJSONObject(i);
            if (ep == null || !ep.optString("url").startsWith("http")) throw new IllegalArgumentException("分集播放地址无效");
            String key = ep.optString("key", "");
            if (!key.isEmpty() && !key.matches("[0-9a-f]{32}")) throw new IllegalArgumentException("分集密钥无效");
        }
        String id = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        Task task = new Task(id, source, title, episodes);
        task.keepRaw = keepRaw;
        task.cover = cover == null ? "" : cover;
        tasks.add(0, task);
        persist();
        pool.execute(() -> run(task));
        return task.snapshot();
    }

    JSONArray list() {
        // 手机下载按内容模式隔离：红果（公开）与黄果（私密）的任务互不出现在对方列表里。
        // 任务 source 字段就是下载时的模式（hongguo | huangguo），旧记录同样适用。
        String active = ContentMode.get(context).active();
        JSONArray out = new JSONArray();
        synchronized (tasks) { for (Task t : tasks) if (active.equals(t.source)) out.put(t.snapshot()); }
        return out;
    }

    /** 该任务在本机的可播放产物：合并整剧文件优先，其次逐集文件（第NN集.mp4）。 */
    JSONObject localFiles(String id) {
        Task found = null;
        synchronized (tasks) {
            for (Task t : tasks) if (t.id.equals(id)) { found = t; break; }
        }
        if (found == null) throw new IllegalStateException("任务不存在");
        if (!ContentMode.get(context).active().equals(found.source))
            throw new IllegalStateException("内容已切换，请重新打开");
        String safe = found.title == null || found.title.isEmpty() ? "download"
                : found.title.replaceAll("[\\\\/:*?\"<>|]", "_");
        File dir = episodeDir(found.title);
        // 读取前先正名一次：个别 ROM 导出后 MediaScanner 异步撞名去重会把「第03集.mp4」改成
        // 「第03集_1793285687971.mp4」，正名窗口可能没追上 —— 播放器读目录前再兜一次，
        // 保证用户点播放时名字已经是干净的（用户实测：第三集带时间戳 → 只识别出 2 集）。
        normalizeEpisodeNames(dir);
        JSONObject out = new JSONObject();
        JSONArray episodes = new JSONArray();
        String merged = "";
        try {
            File official = new File(dir, safe + ".mp4");
            if (official.exists() && official.length() > 0) merged = official.getAbsolutePath();
            File[] children = dir.listFiles();
            if (children != null) {
                java.util.List<File> parts = new java.util.ArrayList<>();
                for (File f : children) {
                    String n = f.getName();
                    // 兼容正名失败残留的时间戳名「第03集_1793285687971.mp4」——同样算第 3 集
                    if (f.length() > 0 && n.matches("第\\d+集(?:_\\d+)?\\.mp4")) parts.add(f);
                }
                java.util.Collections.sort(parts, (a, b) -> episodeNo(a.getName()) - episodeNo(b.getName()));
                for (File f : parts) {
                    episodes.put(new JSONObject().put("index", episodeNo(f.getName())).put("path", f.getAbsolutePath()));
                }
            }
            out.put("title", found.title).put("cover", found.cover).put("source", found.source)
                    .put("merged", merged).put("episodes", episodes);
        } catch (Exception e) { throw new IllegalStateException("读取本地文件失败：" + e.getMessage()); }
        return out;
    }

    private static int episodeNo(String name) {
        try { return Integer.parseInt(name.replaceAll("^第(\\d+)集(?:_\\d+)?\\.mp4$", "$1")); }
        catch (Exception e) { return 0; }
    }

    void cancel(String id) {
        synchronized (tasks) {
            for (Task t : tasks) {
                if (t.id.equals(id)) { t.canceled = true; t.status = "canceled"; t.detail = "已取消"; t.error = "已取消"; }
            }
        }
        persist();
    }

    /** 重试失败/取消的任务：重置状态重新执行 run()；已下载分集自动复用（v0.12.2 起保留分集）。 */
    void retry(String id) {
        Task found = null;
        synchronized (tasks) {
            for (Task t : tasks) {
                if (t.id.equals(id)) { found = t; break; }
            }
        }
        if (found == null) return;
        final Task target = found;
        synchronized (target) {
            target.canceled = false;
            target.status = "running";
            target.percent = 0;
            target.doneCount = 0;
            target.detail = "重新下载";
            target.error = "";
            target.debug = "";
            target.output = "";
        }
        persist();
        pool.execute(() -> run(target));
    }

    /** 删除已完成/失败的任务：移除任务记录，删除已保存的产物（MediaStore 或文件，支持 | 分隔的多产物），
     *  并删除该任务的分集目录（files/downloads/<id>/：密文分集 ep*.mp4 + seg_v6 规范化缓存 + merged.mp4 + 日志），
     *  防止存储膨胀。 */
    void delete(String id) {
        synchronized (tasks) {
            for (Task t : tasks) {
                if (t.id.equals(id)) {
                    t.canceled = true;
                    String output = t.output;
                    tasks.remove(t);
                    if (output != null && !output.isEmpty()) {
                        for (String o : output.split("\\|")) {
                            if (o.isEmpty()) continue;
                            try {
                                if (o.startsWith("content://")) {
                                    context.getContentResolver().delete(Uri.parse(o), null, null);
                                } else {
                                    File f = new File(Uri.parse(o).getPath());
                                    if (f.exists()) f.delete();
                                }
                            } catch (Exception ignored) { }
                        }
                    }
                    // 兜底：删除公共 Downloads/Veyra/<剧名>/ 下该剧全部产物与残留
                    //（含 MediaStore 同名冲突时系统自动加 "_时间戳" 后缀的孤儿文件、空文件夹）
                    purgePublicExports(t);
                    // 删除整个分集/缓存目录（含正在合并的 merged.mp4、seg_v6 缓存、native.log）
                    // 任务目录可能在公共 Download/Veyra 或私有 downloads，两处都清
                    File dir = dlDir(t.id);
                    if (dir.exists()) deleteRecursive(dir);
                    File dirPriv = new File(context.getFilesDir(), "downloads/" + t.id);
                    if (dirPriv.exists()) deleteRecursive(dirPriv);
                    break;
                }
            }
        }
        persist();
    }

    // ---- 执行 ----
    // 并发下载数：一次最多同时下载 N 集（与后端 worker 并发思路一致），跑完一集线程池自动接下一集
    private static final int DL_CONCURRENCY = 10;
    /** m3u8 递归展开总请求计数（防变种列表指数爆炸，每集开始前重置） */
    private int expandCount = 0;

    /** 分集/分片任务目录：优先公共 Download/Veyra（文件管理器实时可见，ts 下多少存多少，
     *  与后端落盘一致）；公共目录不可写（老系统无权限等）时回退应用私有目录。 */
    @SuppressWarnings("deprecation")
    private File dlDir(String id) {
        File pub = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Veyra/dl_" + id);
        try {
            pub.mkdirs();
            if (pub.isDirectory()) return pub;
        } catch (Exception ignored) { }
        return new File(context.getFilesDir(), "downloads/" + id);
    }

    /** 分集/整剧产物目录：Download/Veyra/<剧名>/（转码成功的分集与合并产物都放这里，
     *  不是任务 ID 目录）；不可写时回退应用私有目录。 */
    @SuppressWarnings("deprecation")
    private File episodeDir(String title) {
        String sub = (title == null || title.isEmpty()) ? "download" : title.replaceAll("[\\\\/:*?\"<>|]", "_");
        File pub = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Veyra/" + sub);
        try {
            pub.mkdirs();
            if (pub.isDirectory()) return pub;
        } catch (Exception ignored) { }
        File fb = new File(context.getFilesDir(), "downloads/" + sub);
        try { fb.mkdirs(); } catch (Exception ignored) { }
        return fb;
    }

    private void run(Task task) {
        File dir = dlDir(task.id);
        boolean mergedOk = false;
        try {
            dir.mkdirs();
            int n = task.episodes.length();
            File[] plainArr = new File[n];
            AtomicLong dlBytes = new AtomicLong();
            AtomicLong totalBytes = new AtomicLong();
            AtomicInteger finished = new AtomicInteger();
            ExecutorService dl = Executors.newFixedThreadPool(DL_CONCURRENCY);
            List<Future<?>> futures = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                final int idx = i;
                futures.add(dl.submit(() -> {
                    if (task.canceled) return;
                    JSONObject ep = task.episodes.optJSONObject(idx);
                    String url = ep.optString("url");
                    String key = ep.optString("key", "");
                    // 中间分集一律落在任务目录（Download/Veyra/dl_xxx/），绝不写进剧集目录：
                    // 剧集目录只允许出现用户要看的正式文件「第01集.mp4」「剧名.mp4」。
                    // （旧实现在这里写 <剧名>/ep001.mp4，合并前用户就能看到一堆 ep001/ep002，
                    //   合并失败时更是永久留着 —— 用户实测反馈的「又多出 ep001」就是这个。）
                    File out = new File(dir, String.format(Locale.US, "ep%03d.mp4", idx + 1));
                    // 重试/复用：仅复用「v0.13.8+ 新格式」分集（dlv=raw-v2，原始密文/明文，合并时由 C 层 ffmpeg
                    // 原生解密重封装保持 CFR）。旧版分集（MediaMuxer 重封装产物，帧率被弄成 VFR）一律不复用，
                    // 强制重新下载，避免"快切鬼畜/MPV 卡顿"翻回来。
                    if (out.exists() && out.length() > 0 && "raw-v2".equals(ep.optString("dlv", ""))) {
                        plainArr[idx] = out;
                        int f = finished.incrementAndGet();
                        task.doneCount = f;
                        task.detail = "复用已下载分集 " + f + "/" + n + "（并发 " + DL_CONCURRENCY + "）";
                        return;
                    }
                    try {
                        if ("hongguo".equals(task.source)) downloadHongguo(task, url, key, out, idx, dlBytes, totalBytes, n);
                        else if (isHuangguoM3u8Url(url)) {
                            downloadM3u8(task, url, out, dlBytes, totalBytes, idx + 1);
                            ep.put("src", "hg");   // 黄果标记：单集已是方案2合并的标准 mp4，跳过后续 concat 转码
                        }
                        else downloadPlain(task, url, out, dlBytes, totalBytes, n);
                        ep.put("dlv", "raw-v2");   // 标记新格式（随任务持久化，重试时据此判定可复用）
                        plainArr[idx] = out;
                        int f = finished.incrementAndGet();
                        task.doneCount = f;
                        task.detail = "下载中 " + f + "/" + n + " 集完成（并发 " + DL_CONCURRENCY + "）";
                    } catch (Exception e) {
                        // 一集失败只记录该集，不再 cancel 全部并发集：已下载/合并完成的集照常落位，
                        // 避免"某集失败 → 其余集被取消跳过合并"导致反复重试（用户实测痛点）
                        Throwable c = (e instanceof RuntimeException && e.getCause() != null) ? e.getCause() : e;
                        task.error = (task.error == null ? "" : task.error + "\n") + "第 " + (idx + 1) + " 集失败: " + c;
                        throw new RuntimeException(c);
                    }
                }));
            }
            Exception firstErr = null;
            for (Future<?> f : futures) {
                try { f.get(); }
                catch (Exception e) {
                    if (firstErr == null) {
                        Throwable cause = e.getCause() != null ? e.getCause() : e;
                        firstErr = cause instanceof Exception ? (Exception) cause : new RuntimeException(cause);
                    }
                }
            }
            dl.shutdown();
            if (task.canceled && firstErr == null) return;   // 用户取消：不合并
            if (firstErr != null) throw firstErr;
            List<File> plain = new ArrayList<>();
            for (File f : plainArr) if (f != null) plain.add(f);
            if (plain.size() != n) throw new java.io.IOException("部分分集下载失败（" + plain.size() + "/" + n + "）");
            if (task.canceled) return;
            // 调试模式：各集的 TS/KEY 已在 downloadM3u8 里打包导出到公共 Downloads，
            // 这里不再做「归一化 + 导出 mp4」（本来也没有产物），直接把任务收尾成完成态。
            if (task.keepRaw) {
                task.doneCount = n;
                task.percent = 100;
                task.status = "done";
                task.detail = "调试模式：TS/KEY 已打包，未合并";
                persist();
                return;
            }
            // 下载完成后：逐集 ffmpeg 解密归一化并导出到公共 Downloads（文件管理器立即可见可播）
            String subDir = task.title.replaceAll("[\\\\/:*?\"<>|]", "_");
            // 不再做「导出前清空剧集目录」：上一批下载的正式分集（第01/02/03集.mp4）会被当残留误删
            //（用户实测：先下1-3集再下4-6集，4-6导出前把1-3全清了）。单文件同名撞 MediaStore 的
            // 问题由 exportToDownloads 的 cleanExportTarget 在写之前逐文件处理，不需要全目录清。
            StringBuilder outList = new StringBuilder();
            int directOk = 0;
            for (int i = 0; i < plain.size(); i++) {
                if (task.canceled) return;
                task.percent = 90 + Math.min(9, (int) ((i + 1) * 9.0 / Math.max(1, plain.size())));
                JSONObject ep = task.episodes.optJSONObject(i);
                int realSeq = ep != null ? ep.optInt("index", i + 1) : i + 1;
                task.detail = "解密导出 第" + realSeq + "集（" + (i + 1) + "/" + n + "）";
                task.doneCount = i + 1;
                String key = ep != null ? ep.optString("key", "") : "";
                boolean isHg = ep != null && "hg".equals(ep.optString("src", ""));
                try {
                    File norm = new File(dir, "norm_" + (i + 1) + ".mp4");
                    if (isHg) {
                        // 黄果：单集已是方案2合并的标准 mp4，直接复制导出，跳过 native concat
                        //（libffconcat 对 h264 输入 + hev1 输出会卡死，UI 停在合并中）
                        if (!norm.exists() || norm.length() == 0) {
                            java.nio.file.Files.copy(plain.get(i).toPath(), norm.toPath(),
                                java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                        }
                    } else if (!norm.exists() || norm.length() == 0) {
                        // 红果 CENC 密文分集：先本地解密成明文 MP4（等价后端 ffmpeg -decryption_key -c copy）。
                        // 不能直接走 native concat —— C 层"直接 concat"路径打开分集时不传 decryption_key，
                        // 产物是未解密的密文（大小完整、容器/时长正常，但样本全是密文，任何播放器都播不了）。
                        byte[] kb = com.hongguotv.core.LocalRemux.INSTANCE.keyFromHex(key);
                        if (kb != null) {
                            com.hongguotv.core.LocalRemux.INSTANCE.decrypt(plain.get(i), norm, kb);
                        } else {
                            List<File> single = new ArrayList<>();
                            single.add(plain.get(i));
                            List<String> singleKey = new ArrayList<>();
                            singleKey.add(key);
                            StringBuilder dbg = new StringBuilder();
                            FFmpegConcat.concat(single, singleKey, norm, "hvc1", dbg,
                                new File(context.getFilesDir(), "native.log"));
                        }
                    }
                    String epName = String.format(Locale.US, "第%02d集.mp4", realSeq);
                    long normLen = norm.length();
                    Uri u = exportToDownloads(norm, subDir, epName);
                    if (lastExportDirect) directOk++;
                    if (u != null) { if (outList.length() > 0) outList.append('|'); outList.append(u); }
                    // 删除临时归一化文件（公共 Downloads 已有副本）
                    norm.delete();
                    // 每导出一集就查一次名字，被改名立刻正名（别等全部导出完 —— 中间隔得越久，
                    // 越可能留下一个带时间戳的名字被用户看到）
                    normalizeEpisodeNames(episodeDir(task.title));
                    // 导出成功 → 任务目录里的中间产物也删掉：剧集目录已经是同一集的正片，
                    // 再留一份就是「同一部剧出现两个文件夹、内容完全重复」（用户实测反馈的 dl_xxx
                    // 与剧名目录并存就是这么来的）。合并阶段改从剧集目录的「第NN集.mp4」读，
                    // 见 runMerge 的查找顺序。
                    // 但必须先确认公共目录那份**真的能用 File 读到**（个别 ROM 上 MediaStore 写入
                    // 成功、直接路径却读不了）：读不到就保留中间产物，合并走任务目录那条兜底。
                    File src = plain.get(i);
                    File pubEp = publicEpisodeFile(task.title, epName);
                    if (u != null && src != null && !src.equals(norm)
                            && pubEp.exists() && pubEp.length() == normLen) {
                        src.delete();
                    }
                } catch (Exception ex) {
                    // 单集导出失败不阻塞任务，原始密文仍在 app 私有目录供合并
                }
            }
            // 兜一层：个别 ROM 连「直接改名」都不让，名字会留成「第01集_1793034343293.mp4」。
            // 导出全部结束后再统一正名一次，保证文件管理器里看到的就是「第01集.mp4」。
            // MediaScanner 是异步的：写完后它可能稍后才做撞名去重，把文件改成「第NN集_<毫秒>.mp4」，
            // 而正名若跑在扫描落地之前就白做。所以：等 1.2s（扫描窗口）→ 正名 → 再等 0.5s → 再正名复查。
            try { Thread.sleep(1200); } catch (InterruptedException ignored) { }
            normalizeEpisodeNames(episodeDir(task.title));
            try { Thread.sleep(500); } catch (InterruptedException ignored) { }
            normalizeEpisodeNames(episodeDir(task.title));
            task.status = "ready";
            task.percent = 100;
            // 直写成功就不加后缀（正常情况）；只要有一集走了 MediaStore 回退，就把计数带上，
            // 便于一眼判断「名字不对」到底是我们写不进去、还是系统事后改的。
            task.detail = "已下载 " + n + " 集，待合并"
                    + (directOk == n ? "" : "（直写 " + directOk + "/" + n + "）");
            task.output = outList.toString();
            persist();
            return;
        } catch (Exception e) {
            if (!task.canceled) {
                task.status = "failed";
                // 内部（如合并失败）已写详细 task.error 时保留，不覆盖成短消息
                if (task.error == null || task.error.isEmpty())
                    task.error = e.getMessage() == null ? "下载失败" : e.getMessage();
                String msg = e.getMessage();
                if (msg != null) {
                    int cut = msg.indexOf('\n');
                    if (cut > 0) msg = msg.substring(0, cut);
                    if (msg.length() > 34) msg = msg.substring(0, 34) + "…";
                    task.detail = "失败：" + msg;
                } else task.detail = "失败";
            }
        } finally {
            persist();
            // 调试模式：保留已下载分集（ep*.mp4）与合并产物副本，供换版本后直接重新合并；
            // 只清理合并失败残留的半成品（merged.mp4）与临时 concat 列表。
            try {
                File merged = new File(dir, "merged.mp4");
                if (!mergedOk && merged.exists()) deleteRecursive(merged);
                File[] kids = dir.listFiles();
                if (kids != null) for (File f : kids) {
                    if (f.isFile() && f.getName().startsWith("inputs_") && f.getName().endsWith(".ffconcat")) f.delete();
                }
                // 目录已经空了就顺手删掉：失败/取消的任务会留下 0 项的 dl_xxx 文件夹，
                // 文件管理器里一排空目录很难看（老用户升级后也能被这里清掉）
                File[] left = dir.listFiles();
                if (left != null && left.length == 0) dir.delete();
            } catch (Exception ignored) {}
        }
    }

    /** 转发模式（proxyMode=3）：创建"NAS 下载→手机拉取"任务。文件由 forwardPull 逐集写入
     *  downloads/<id>/epNNN.mp4，拉满自动置 ready，可直接走 merge() 合并导出。 */
    JSONObject forwardPrepare(String title, int count, String nasTaskId) throws Exception {
        if (title == null || title.trim().isEmpty() || count <= 0) throw new IllegalArgumentException("参数无效");
        String id = "fwd-" + Long.toHexString(System.currentTimeMillis());
        JSONArray eps = new JSONArray();
        for (int i = 0; i < count; i++) eps.put(new JSONObject().put("index", i + 1));
        Task t = new Task(id, "huangguo", title, eps);
        t.status = "pulling";
        t.detail = "等待 NAS 下载完成";
        t.percent = 3;
        t.nasTaskId = nasTaskId == null ? "" : nasTaskId;
        synchronized (tasks) { tasks.add(t); }
        persist();
        return t.snapshot();
    }

    /** 转发模式：写入一集从 NAS 拉取的 mp4（epNNN.mp4）。全部拉满置 ready 可合并。 */
    JSONObject forwardPull(String id, int index, byte[] bytes) throws Exception {
        Task found = null;
        synchronized (tasks) { for (Task t : tasks) if (t.id.equals(id)) { found = t; break; } }
        if (found == null) throw new IllegalStateException("任务不存在");
        if (bytes == null || bytes.length == 0) throw new java.io.IOException("拉取内容为空");
        File dir = dlDir(id);
        if (!dir.exists() && !dir.mkdirs()) throw new java.io.IOException("无法创建任务目录");
        File out = new File(dir, String.format(Locale.US, "ep%03d.mp4", index));
        try (FileOutputStream fos = new FileOutputStream(out)) { fos.write(bytes); }
        int n = found.episodes.length();
        int pulled = 0;
        for (int i = 0; i < n; i++) {
            File f = new File(dir, String.format(Locale.US, "ep%03d.mp4", i + 1));
            if (f.exists() && f.length() > 0) pulled++;
        }
        found.detail = "已从 NAS 拉取 " + pulled + "/" + n + " 集";
        found.percent = 8 + Math.round(80f * pulled / n);
        if (pulled == n) {
            found.status = "ready";
            found.detail = "已拉取全部 " + n + " 集，可合并";
            found.percent = 90;
        }
        persist();
        return found.snapshot();
    }

    /** 转发模式：拉取 NAS 合并产物（单文件完整成品）。保存为 <title>_全N集.mp4，任务直接完成。 */
    JSONObject forwardPullMerged(String id, byte[] bytes) throws Exception {
        Task found = null;
        synchronized (tasks) { for (Task t : tasks) if (t.id.equals(id)) { found = t; break; } }
        if (found == null) throw new IllegalStateException("任务不存在");
        if (bytes == null || bytes.length == 0) throw new java.io.IOException("拉取内容为空");
        File dir = dlDir(id);
        if (!dir.exists() && !dir.mkdirs()) throw new java.io.IOException("无法创建任务目录");
        String safe = (found.title == null ? "" : found.title).replaceAll("[\\\\/:*?\"<>|]", "_");
        int n = found.episodes.length();
        File out = new File(dir, safe + "_全" + n + "集.mp4");
        try (FileOutputStream fos = new FileOutputStream(out)) { fos.write(bytes); }
        found.status = "done";
        found.detail = "已从 NAS 拉取完整成品";
        found.percent = 100;
        found.output = out.getAbsolutePath();
        persist();
        return found.snapshot();
    }

    /** 手动合并：等待合并信号后执行（任务须处于 ready/failed 状态；合并失败保留分集可重试）。 */
    JSONObject merge(String id) {
        Task found = null;
        synchronized (tasks) {
            for (Task t : tasks) {
                if (t.id.equals(id)) { found = t; break; }
            }
        }
        if (found == null) throw new IllegalStateException("任务不存在");
        final Task target = found;
        synchronized (target) {
            if (!"ready".equals(target.status) && !"failed".equals(target.status))
                throw new IllegalStateException("当前状态不可合并（需先完成下载）");
            target.status = "running";
            target.error = "";
            target.debug = "";
            target.detail = "合并分集";
            target.percent = 90;
        }
        persist();
        pool.execute(() -> runMerge(target));
        return target.snapshot();
    }

    private void runMerge(Task task) {
        File dir = dlDir(task.id);
        boolean mergedOk = false;
        try {
            int n = task.episodes.length();
            // 先把名字漂移（第01集_1793034343293.mp4）的集数正名回来，再按「集号」找人。
            // 分集文件名是合并找人的依据，名字被动过就报「分集不完整」，所以这里既修名、也不依赖名。
            File edir = episodeDir(task.title);
            normalizeEpisodeNames(edir);
            java.util.Map<Integer, File> named = episodeFilesIn(edir);
            List<File> plain = new ArrayList<>();
            // 与 plain 一一对应的解密密钥：中间产物可能是 CENC 密文 → 要 key；
            // 剧集目录里的「第NN集.mp4」是已解密归一化的正式分集 → 传空串，让 C 层按明文处理。
            List<String> plainKeys = new ArrayList<>();
            // 本任务真实集号 → 批次序号映射（中间产物 epNNN 是下载批次顺序，需要时按此兜底）
            java.util.Map<Integer, Integer> seqToBatch = new java.util.HashMap<>();
            java.util.Set<Integer> wanted = new java.util.TreeSet<>();
            for (int i = 0; i < n; i++) {
                JSONObject ep = task.episodes.optJSONObject(i);
                int seq = ep != null ? ep.optInt("index", i + 1) : i + 1;
                wanted.add(seq);
                seqToBatch.put(seq, i);
            }
            // 收集顺序（同剧分次下载 → 一次合并整部，产物自然累积，不再互相覆盖）：
            //   ① 已有合并产物「剧名.mp4」  —— 此前批次合并的成品，作为第一段，后续分集接在其后
            //   ② 剧集目录全部「第NN集.mp4」 —— 本任务 + 同剧其它批次导出的正式分集（明文，升序）
            //   ③ 本任务在剧集目录缺失的集   —— 任务目录 epNNN 中间产物兜底（可能密文，带 key）
            List<Integer> plainSeqs = new ArrayList<>();
            File existing = new File(edir, task.title.replaceAll("[\\\\/:*?\"<>|]", "_") + ".mp4");
            if (existing.exists() && existing.length() > 0) { plain.add(existing); plainKeys.add(""); plainSeqs.add(0); }
            java.util.Set<Integer> allSeq = new java.util.TreeSet<>(named.keySet());
            allSeq.addAll(wanted);
            for (int seq : allSeq) {
                File f = named.get(seq);
                if (f != null && f.exists() && f.length() > 0) { plain.add(f); plainKeys.add(""); plainSeqs.add(seq); continue; }
                if (!wanted.contains(seq)) continue;   // 同剧其它批次缺失的那几集，下次下载后再合并补上
                Integer batch = seqToBatch.get(seq);
                if (batch == null) continue;
                f = new File(dir, String.format(Locale.US, "ep%03d.mp4", batch + 1));
                if (f.exists() && f.length() > 0) { plain.add(f); plainKeys.add(task.episodes.optJSONObject(batch).optString("key", "")); plainSeqs.add(seq); }
            }
            // 完整性：本任务每集必须命中（同剧其它批次缺失不阻塞）
            int got = 0;
            for (int seq : wanted) if (plainSeqs.contains(seq)) got++;
            if (got != wanted.size()) throw new java.io.IOException("分集不完整（" + got + "/" + wanted.size() + "），请重新下载");
            // 优先合并成单个文件；若合并仍失败（个别设备 MediaMuxer 兼容问题），自动回退为分集逐个导出，下载不白费。
            String subDir = task.title.replaceAll("[\\\\/:*?\"<>|]", "_");
            String displayName = task.title.replaceAll("[\\\\/:*?\"<>|]", "_") + ".mp4";
            try {
                task.detail = "合并分集";
                File merged = null;
                if (plain.size() == 1 && plainSeqs.get(0) == 0) {
                    // 只有已有合并产物、没有新分集：已是最新成品，直接复用，跳过重封装
                    merged = existing;
                    mergedOk = true;
                } else if (plain.size() == 1) {
                    merged = new File(dir, "merged.mp4");
                    // 红果 CENC 密文：本地解密成明文 MP4（等价后端 ffmpeg -decryption_key -c copy）。
                    // 不能直接走 native concat —— C 层"直接 concat"路径不传 decryption_key，产物是密文播不了。
                    byte[] kb = com.hongguotv.core.LocalRemux.INSTANCE.keyFromHex(plainKeys.get(0));
                    if (kb != null) {
                        com.hongguotv.core.LocalRemux.INSTANCE.decrypt(plain.get(0), merged, kb);
                    } else {
                        List<String> k1 = new ArrayList<>();
                        k1.add(plainKeys.get(0));
                        StringBuilder dbg = new StringBuilder();
                        FFmpegConcat.concat(plain, k1, merged, "hvc1", dbg, new File(context.getFilesDir(), "native.log"));
                        task.debug = dbg.toString();
                    }
                } else {
                    merged = new File(dir, "merged.mp4");
                    mergeMp4(plain, plainKeys, merged, task);
                }
                if (task.canceled) return;
                task.percent = 97;
                task.detail = "保存到手机";
                Uri publicUri = exportToDownloads(merged, subDir, displayName);
                task.output = publicUri != null ? publicUri.toString() : merged.getAbsolutePath();
                mergedOk = true;
            } catch (Exception mergeErr) {
                // 合并失败 → 记录详细原因（阶段日志+异常+堆栈），回退分集导出
                StringBuilder eb = new StringBuilder();
                eb.append("合并失败：").append(mergeErr.getMessage() == null ? mergeErr.getClass().getSimpleName() : mergeErr.getMessage());
                if (task.debug != null && !task.debug.isEmpty()) eb.append('\n').append(task.debug);
                eb.append("\n异常类型: ").append(mergeErr.getClass().getName());
                int stCnt = 0;
                for (StackTraceElement st : mergeErr.getStackTrace()) {
                    String cn = st.getClassName();
                    if (cn.contains("gybeyond") || cn.contains("MediaMuxer") || cn.contains("MediaExtractor") || cn.contains("MediaCodec")) {
                        eb.append("\n  at ").append(cn).append('.').append(st.getMethodName())
                          .append('(').append(st.getFileName()).append(':').append(st.getLineNumber()).append(')');
                        if (++stCnt >= 15) break;
                    }
                }
                task.error = eb.toString();
                task.debug = eb.toString();
                StringBuilder outList = new StringBuilder();
                for (int i = 0; i < plain.size(); i++) {
                    if (task.canceled) return;
                    if (plainSeqs.get(i) == 0) continue;   // 已有合并产物不重导出
                    task.percent = 90 + Math.min(9, (int) ((i + 1) * 9.0 / Math.max(1, plain.size())));
                    String epName = String.format(Locale.US, "第%02d集.mp4", plainSeqs.get(i));
                    Uri u = exportToDownloads(plain.get(i), subDir, epName);
                    if (u != null) { if (outList.length() > 0) outList.append('|'); outList.append(u); }
                }
                task.output = outList.toString();
            }
            if (task.canceled) return;
            if (mergedOk) {
                task.status = "done"; task.percent = 100;
                task.detail = "完成（已合并）";
                // 合并成功：删除分集（app 私有 ep*.mp4/norm_* + 公共 Downloads 第XX集.mp4），只保留合并产物
                deleteEpisodesAfterMerge(task, subDir);
                // 同剧其它待合并任务：分集已并入完整产物，同步标记完成，避免列表残留「待合并」假象
                synchronized (tasks) {
                    for (Task t : tasks) {
                        if (t == task || t.canceled) continue;
                        if (t.title != null && t.title.equals(task.title)
                                && ("ready".equals(t.status) || "failed".equals(t.status))) {
                            t.status = "done"; t.percent = 100; t.detail = "完成（已合并）";
                        }
                    }
                }
                persist();
            } else {
                // 合并失败：状态置 failed → 下载列表显示「重试」按钮（分集已导出保留，
                // 点重试会复用已下载分集直接合并，无需重新下载）。
                task.status = "failed"; task.percent = 100;
                task.detail = "合并失败（已保存 " + plain.size() + " 集分集，可直接重试合并）";
            }
        } catch (Exception e) {
            if (!task.canceled) { task.status = "failed"; task.error = e.getMessage() == null ? "合并失败" : e.getMessage(); task.detail = "失败"; }
        } finally {
            persist();
            try {
                File merged = new File(dir, "merged.mp4");
                if (!mergedOk && merged.exists()) deleteRecursive(merged);
                File[] kids = dir.listFiles();
                if (kids != null) for (File f : kids) {
                    if (f.isFile() && f.getName().startsWith("inputs_") && f.getName().endsWith(".ffconcat")) f.delete();
                }
            } catch (Exception ignored) {}
        }
    }

    private void downloadHongguo(Task task, String url, String keyHex, File out, int idx,
                                 AtomicLong dlBytes, AtomicLong totalBytes, int n) throws Exception {
        // 与后端 1:1：直接下载原始分集（CENC 密文或明文），解密+重封装统一放到合并阶段由
        // ffmpeg -decryption_key 原生处理（等价后端 downloader.js：下载密文 → ffmpeg 解密重封装）。
        // 彻底绕开 MediaExtractor+MediaMuxer 重封装——它会把源 CFR 时间戳弄成 VFR（MPV 卡顿根因）。
        downloadPlain(task, url, out, dlBytes, totalBytes, n);
    }

    /** 整体下载进度：已下载字节 / 已探测到的总字节（各集下载线程各自累计，90% 封顶，合并阶段再走 90-99）。 */
    private static void updateDownloadProgress(Task task, AtomicLong dlBytes, AtomicLong totalBytes) {
        long tb = totalBytes.get();
        if (tb <= 0) return;
        int p = Math.min(90, (int) (dlBytes.get() * 90.0 / tb));
        if (p > task.percent) task.percent = p;   // 只升不降（总字节渐进探知时避免百分比回跳）
    }

    /** 等价后端 ffmpeg -decryption_key -i <raw> -c copy -f mp4 <out>：把解密产物完整重新封装为标准明文 MP4。
     *  MediaExtractor 读样本 → MediaMuxer 重写（stco/stsz/stss/mdhd 全部由 muxer 正确生成）。
     *  处理 avc3/hev1 缺 csd（流式扫描首关键帧提取 SPS/PPS，HEVC 含 VPS）；
     *  音视频保留源内相对偏移（统一基准 = min(首视频PTS, 首音频PTS)，与后端 concat 行为一致）。
     *  流式两遍（首遍定位/提取，第二遍写），不整集驻留内存。 */
    private static void normalizeEpisode(File in, File out) throws Exception {
        MediaExtractor ex = new MediaExtractor();
        ex.setDataSource(in.getAbsolutePath());
        int vIdx = -1, aIdx = -1;
        for (int t = 0; t < ex.getTrackCount(); t++) {
            String mime = ex.getTrackFormat(t).getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("video/")) vIdx = t;
            else if (mime != null && mime.startsWith("audio/")) aIdx = t;
        }
        if (vIdx < 0) throw new java.io.IOException("分集没有视频轨道");
        MediaFormat vf = ex.getTrackFormat(vIdx);
        MediaFormat af = aIdx >= 0 ? ex.getTrackFormat(aIdx) : null;
        ex.release();
        String vmime = vf.getString(MediaFormat.KEY_MIME);
        // 1) avc3/hev1 缺 csd：流式扫描首个关键帧，提取 SPS/PPS（HEVC 含 VPS）
        if (!vf.containsKey("csd-0")) {
            boolean hevc = vmime != null && vmime.startsWith("video/hevc");
            List<byte[]> nal = null;
            MediaExtractor se = new MediaExtractor();
            try {
                se.setDataSource(in.getAbsolutePath());
                se.selectTrack(vIdx);
                while (se.advance()) {
                    if ((se.getSampleFlags() & MediaCodec.BUFFER_FLAG_KEY_FRAME) == 0) continue;
                    long sz = se.getSampleSize();
                    if (sz <= 0 || sz > 4 * 1024 * 1024) continue;
                    ByteBuffer bb = ByteBuffer.allocate((int) sz);
                    int n = se.readSampleData(bb, 0);
                    if (n <= 0) continue;
                    bb.position(0); bb.limit(n);
                    List<byte[]> p = extractParameterSets(bb, hevc);
                    if (!p.isEmpty()) { nal = p; break; }
                }
            } finally { se.release(); }
            if (nal == null) throw new java.io.IOException("无法提取视频参数集(csd)");
            int total = 0; for (byte[] b : nal) total += b.length;
            ByteBuffer csd = ByteBuffer.allocate(total);
            for (byte[] b : nal) csd.put(b);
            csd.position(0);
            vf.setByteBuffer("csd-0", csd);
        }
        // 2) 音视频各自归零基准（等价后端 ffmpeg -c copy 输出从 0 起），并交错写入
        long vFirst = Math.max(0, firstSamplePts(in, vIdx));
        long aFirst = af != null ? Math.max(0, firstSamplePts(in, aIdx)) : vFirst;
        // 3) 流式重写
        MediaMuxer muxer = new MediaMuxer(out.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        try {
            int vt = muxer.addTrack(vf);
            int at = af != null ? muxer.addTrack(af) : -1;
            muxer.start();
            writeInterleavedStream(in, vIdx, aIdx, muxer, vt, at, vFirst, aFirst);
            muxer.stop();
        } finally { muxer.release(); }
    }

    private static long firstSamplePts(File file, int track) throws Exception {
        MediaExtractor ex = new MediaExtractor();
        try {
            ex.setDataSource(file.getAbsolutePath());
            ex.selectTrack(track);
            return ex.advance() ? ex.getSampleTime() : -1;
        } finally { ex.release(); }
    }

    /** 整轨流式写入（解码序，PTS 单调化），等价 mergeMp4 的 writeSamples 但按文件边读边写。 */
    private void downloadPlain(Task task, String url, File out, AtomicLong dlBytes, AtomicLong totalBytes, int n) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(60_000);
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36");
        try {
            int code = conn.getResponseCode();
            if (code != 200) throw new java.io.IOException("下载失败 HTTP " + code);
            long total = conn.getContentLengthLong();
            totalBytes.addAndGet(Math.max(total, 0));
            try (InputStream in = conn.getInputStream(); FileOutputStream fos = new FileOutputStream(out)) {
                byte[] buffer = new byte[128 * 1024];
                int k; long received = 0;
                while ((k = in.read(buffer)) > 0) {
                    if (task.canceled) return;
                    fos.write(buffer, 0, k);
                    received += k;
                    dlBytes.addAndGet(k);
                    updateDownloadProgress(task, dlBytes, totalBytes);
                }
            }
        } finally { conn.disconnect(); }
    }

    // ---- 黄果源 m3u8 本地下载：APK 直拉 m3u8/分片（走后端代理同播放链路），本地 ffmpeg 封装 mp4 ----
    private boolean isHuangguoM3u8Url(String url) {
        if (url == null) return false;
        return url.contains("/api/huangguo-proxy?")
                || url.contains(".m3u8") || url.contains("m3u8")
                || url.contains("video.225600.xyz");   // 仅直连模式下 episode source 是源站 m3u8 直链，兜底识别
    }

    /** 递归展开 m3u8（代理已把 URI 重写为绝对代理 URL）：收集分片、每段对应 KEY URL 与显式 IV。
     *  每次拉取后刷新 task.detail，让"解析 m3u8 播放列表…"有实时进度（已展开条目/已收集分片），
     *  避免用户面对无进度转圈；fetchBytes 已有 connect/read 超时兜底。 */
    private void expandM3u8(String url, List<String> segs, List<String> segKeys, List<String> segIVs, int depth, Task task, int n, AtomicInteger mediaSeqRef) throws Exception {
        if (depth > 6) throw new java.io.IOException("m3u8 层级过深");
        if (++expandCount > 400) throw new java.io.IOException("m3u8 展开条目过多（>400），疑似变种列表循环");
        task.detail = "解析 m3u8 播放列表… 条目 " + expandCount + "、分片 " + segs.size();
        task.debug = "第 " + n + " 集：解析 m3u8… 条目 " + expandCount + "、分片 " + segs.size() + " → " + shortUrl(url);
        String text = new String(fetchBytes(url), StandardCharsets.UTF_8);
        String currentKey = null;
        String currentIV = "";
        boolean expectSub = false;
        java.util.regex.Matcher keyMatcher = java.util.regex.Pattern.compile("URI=\"([^\"]+)\"").matcher("");
        java.util.regex.Matcher ivMatcher = java.util.regex.Pattern.compile("IV=([0-9a-fA-Fx]+)").matcher("");
        for (String raw : text.split("\r?\n")) {
            String line = raw.trim();
            if (line.startsWith("#EXT-X-KEY")) {
                // METHOD=NONE = 从这一行起分片不加密：必须把上一段的 KEY 清空，
                // 否则明文分片会被当密文解密（解出垃圾 → 合并报"分片解密结果无效"）
                if (line.contains("METHOD=NONE")) {
                    currentKey = null;
                    currentIV = "";
                } else {
                    keyMatcher.reset(line);
                    if (keyMatcher.find()) currentKey = resolveUri(keyMatcher.group(1), url);
                    // 源带显式 IV（如 IV=0x...）必须原样保留：本地 playlist 丢 IV 时 hls demuxer 会用
                    // 媒体序列号作默认 IV 解密，与源不符 → 解密数据全错 → 产物损坏/合并卡死
                    ivMatcher.reset(line);
                    currentIV = ivMatcher.find() ? ivMatcher.group(1) : "";
                }
            } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
                // 记录真实媒体序列号：无显式 IV 的分片用 mediaSeq+i 大端作默认 IV，
                // 本地 playlist 写死 0 会导致这类分片解密错乱（第 2 集 TS 不可播的根因）
                int p = line.indexOf(':');
                if (p >= 0) { try { mediaSeqRef.set(Integer.parseInt(line.substring(p + 1).trim())); } catch (Exception ignored) {} }
            } else if (line.startsWith("#EXT-X-STREAM-INF")) {
                expectSub = true;
            } else if (line.startsWith("#EXT-X-MEDIA")) {
                // 音轨/字幕声明（自带 URI 属性），不是子流：跳过，避免把下一行分片误当子流递归（拿 ts 当 m3u8 解析必失败）
                expectSub = false;
            } else if (!line.isEmpty() && !line.startsWith("#")) {
                String uri = resolveUri(line, url);
                if (expectSub) {
                    // 防误判：递归请求返回的可能不是播放列表（如误把分片当子流），校验含 #EXT 标签才递归，否则忽略该行
                    String subText = new String(fetchBytes(uri), StandardCharsets.UTF_8);
                    if (!subText.contains("#EXT")) {
                        // 非播放列表：该 URL 实际是分片，直接纳入分片列表
                        segs.add(uri); segKeys.add(currentKey); segIVs.add(currentIV);
                    } else {
                        expandM3u8(uri, segs, segKeys, segIVs, depth + 1, task, n, mediaSeqRef);
                    }
                } else { segs.add(uri); segKeys.add(currentKey); segIVs.add(currentIV); }
                expectSub = false;
            }
        }
    }

    private String resolveUri(String line, String base) throws Exception {
        try { return new URL(line).toString(); }
        catch (Exception e) { return new URL(new URL(base), line).toString(); }
    }

    /** curl/HTTP 客户端兼容：源站分片文件名可能含未编码的 ()[]{}，先补编码再请求。 */
    private static String curlSafeUrl(String url) {
        return url.replace("[", "%5B").replace("]", "%5D")
                .replace("(", "%28").replace(")", "%29")
                .replace("{", "%7B").replace("}", "%7D");
    }

    /** 截断 URL 用于进度/错误显示（去协议头，保留域名+路径前缀）。 */
    private static String shortUrl(String url) {
        if (url == null) return "";
        String u = url.replace("https://", "").replace("http://", "");
        if (u.length() > 46) u = u.substring(0, 46) + "…";
        return u;
    }

    /** 解析阶段取小文件（master/子流/playlist）：connect/read 超时外再套 25s 硬超时，
     *  DNS 解析/TLS 握手黑洞时 HttpURLConnection 超时不覆盖，硬超时保证快速失败可重试。
     *  5xx（源/代理过载）与超时做退避重试（0.5s/1s/2s，最多 3 次），等过载恢复。 */
    private byte[] fetchBytes(String url) throws Exception {
        Exception lastErr = null;
        for (int attempt = 1; attempt <= 3; attempt++) {
            ExecutorService pool = Executors.newSingleThreadExecutor();
            try {
                Future<byte[]> f = pool.submit(() -> doFetchBytes(url));
                try {
                    return f.get(25, TimeUnit.SECONDS);
                } catch (TimeoutException te) {
                    f.cancel(true);
                    throw new java.io.IOException("请求超时(25s) " + shortUrl(url));
                }
            } catch (Exception e) {
                lastErr = e;
                if (attempt < 3) {
                    String m = e.getMessage();
                    boolean busy = m != null && (m.startsWith("下载失败 HTTP 5") || m.contains("超时"));
                    Thread.sleep(busy ? 500L * attempt : 300L);
                }
            } finally { pool.shutdownNow(); }
        }
        throw lastErr;
    }

    private byte[] doFetchBytes(String url) throws Exception {
        url = curlSafeUrl(url);
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(20_000);   // 解析阶段都是小文件；过长会掩盖源/代理卡死
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36");
        try {
            int code = conn.getResponseCode();
            if (code != 200) throw new java.io.IOException("下载失败 HTTP " + code);
            byte[] body;
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
                byte[] buf = new byte[64 * 1024];
                int k; long total = 0;
                while ((k = in.read(buf)) > 0) {
                    bo.write(buf, 0, k);
                    total += k;
                    if (total > 8 * 1024 * 1024) throw new java.io.IOException("响应体超限（>8MB），疑似非播放列表");
                }
                body = bo.toByteArray();
            }
            String enc = conn.getContentEncoding();
            if (enc != null && enc.toLowerCase().contains("gzip")) {
                // 黄果源 master 常见 gzip 乱码（无编码头），解压后再返回
                try (java.util.zip.GZIPInputStream gz = new java.util.zip.GZIPInputStream(new java.io.ByteArrayInputStream(body))) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[64 * 1024];
                    int k; long total = 0;
                    while ((k = gz.read(buf)) > 0) {
                        out.write(buf, 0, k);
                        total += k;
                        if (total > 8 * 1024 * 1024) throw new java.io.IOException("解压后响应体超限（>8MB）");
                    }
                    return out.toByteArray();
                }
            }
            return body;
        } finally { conn.disconnect(); }
    }

    /** 全局下载闸：整个任务所有集共享 8 个下载槽（单集并发 8 × 多集同时下载会叠加成 24+ 并发，
     *  把黄果源/CDN 打成 502 限流——v0.18.50/51 实测三集同时重下全部 502）。 */
    private static final java.util.concurrent.Semaphore DL_GATE = new java.util.concurrent.Semaphore(8, true);

    private void downloadToFile(String url, File out, AtomicLong dlBytes, AtomicLong totalBytes) throws Exception {
        url = curlSafeUrl(url);
        // 全局闸：多集并发时共享下载槽（获取不到许可就排队，天然限流，总并发恒 ≤8）
        try { DL_GATE.acquire(); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); throw new java.io.IOException("下载被中断"); }
        try {
            dlToFileInner(url, out, dlBytes, totalBytes);
        } finally {
            DL_GATE.release();
        }
    }

    private void dlToFileInner(String url, File out, AtomicLong dlBytes, AtomicLong totalBytes) throws Exception {
        // 单片 60s 绝对硬超时（看门狗强制断开连接，覆盖部分 ROM readTimeout 对流式挂起失效——read 阻塞时
        // 永不返回，进度卡死）+ 最多 5 次自动重试（换新连接）。5xx（源/代理过载 502/503）退避更久
        // 等过载恢复（0.6s/1.2s/2.4s/4.8s），其他错误 400ms 起步。每片总时长有界，绝不无限卡。
        Exception lastErr = null;
        final int maxAttempt = 5;
        for (int attempt = 1; attempt <= maxAttempt; attempt++) {
            final HttpURLConnection[] connRef = new HttpURLConnection[1];
            Thread wd = null;
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                connRef[0] = conn;
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(30_000);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36");
                // 看门狗：60s 后强制 disconnect（阻塞的 in.read 立刻抛 SocketException → 走重试）
                wd = new Thread(() -> {
                    try { Thread.sleep(60_000); HttpURLConnection c = connRef[0]; if (c != null) try { c.disconnect(); } catch (Exception ignored) {} }
                    catch (InterruptedException ignored) {}
                });
                wd.setDaemon(true);
                wd.start();
                try {
                    int code = conn.getResponseCode();
                    if (code != 200) throw new java.io.IOException("下载失败 HTTP " + code);
                    long total = conn.getContentLengthLong();
                    totalBytes.addAndGet(Math.max(total, 0));
                    try (InputStream in = conn.getInputStream(); FileOutputStream fos = new FileOutputStream(out)) {
                        byte[] buffer = new byte[128 * 1024];
                        int k; long received = 0;
                        long startMs = System.currentTimeMillis();
                        while ((k = in.read(buffer)) > 0) {
                            fos.write(buffer, 0, k);
                            received += k;
                            dlBytes.addAndGet(k);
                            // 收到数据时也检查硬超时：持续小数据流（不触发 readTimeout）时强制放弃重试
                            if (System.currentTimeMillis() - startMs > 55_000) {
                                throw new java.io.IOException("分片下载超时（>55秒）");
                            }
                        }
                    }
                } finally { conn.disconnect(); }
                return;   // 成功
            } catch (Exception e) {
                lastErr = e;
                out.delete();
                if (attempt < maxAttempt) {
                    String m = e.getMessage();
                    boolean serverBusy = m != null && (m.startsWith("下载失败 HTTP 5") || m.contains("超时"));
                    Thread.sleep(serverBusy ? (600L << Math.min(attempt, 4)) : 400L * attempt);
                }
            } finally {
                if (wd != null) wd.interrupt();
            }
        }
        throw lastErr;
    }

    // ---- AES-128 KEY 获取（严格 16 字节校验 + 诊断）----
    // 历史事故：KEY 走通用 downloadToFile，只判"非空即成功"，源站返回的 HTML/风控页/播放列表
    // （用户实测 11545 字节）被当成密钥落盘；复用逻辑又认"非空即已下载"，于是坏 KEY 永久留在
    // work 目录，每集每次都报"KEY 文件异常"，点一万次重试都没用。这里彻底改掉：
    // 只接受 16 字节裸密钥，失败绝不落盘，并把源站真实响应（状态码/长度/内容类型/前 64 字节）记进诊断。
    private static final int KEY_LEN = 16;
    private static final int KEY_MAX_BYTES = 64 * 1024;
    private static final String UA_DESKTOP = "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36";

    /** 取 KEY 字节：先按 m3u8 给的地址（多半是本站代理 URL）取；不行再解包代理直连真实 KEY 地址，
     *  再不行带上 CDN 自身 Referer 重试（部分 CDN 对 KEY 有防盗链，缺 Referer 会返回 HTML 风控页）。
     *  每次失败的原因都追加到 diag（调用方落盘 key-diag.txt + 写进 debug）。 */
    private byte[] fetchKeyBytes(String url, StringBuilder diag) throws Exception {
        String direct = unwrapProxyUrl(url);
        boolean hasDirect = !direct.equals(url);
        List<String[]> cands = new ArrayList<>();   // {URL, Referer}
        cands.add(new String[]{url, null});
        if (hasDirect) {
            cands.add(new String[]{direct, null});
            cands.add(new String[]{direct, originOf(direct)});
        }
        Exception lastErr = null;
        for (int ci = 0; ci < cands.size(); ci++) {
            String cu = cands.get(ci)[0];
            String ref = cands.get(ci)[1];
            int tries = ci == 0 ? 3 : 1;
            for (int attempt = 1; attempt <= tries; attempt++) {
                try {
                    return fetchKeyOnce(cu, ref, diag);
                } catch (Exception e) {
                    lastErr = e;
                    // 退避：源站在展开 m3u8 的几十个请求之后紧接着收到 KEY 请求时容易直接甩限流页，
                    // 隔一会儿重试往往就正常了（KEY 只有 16 字节，重试成本极低）
                    if (attempt < tries) Thread.sleep(700L * attempt);
                }
            }
        }
        throw lastErr != null ? lastErr : new java.io.IOException("KEY 下载失败");
    }

    private static String originOf(String url) {
        try {
            URL u = new URL(url);
            return u.getProtocol() + "://" + u.getHost() + "/";
        } catch (Exception e) {
            return null;
        }
    }

    private byte[] fetchKeyOnce(String url, String referer, StringBuilder diag) throws Exception {
        String u = curlSafeUrl(url);
        HttpURLConnection conn = (HttpURLConnection) new URL(u).openConnection();
        conn.setConnectTimeout(10_000);
        conn.setReadTimeout(15_000);
        conn.setRequestProperty("User-Agent", UA_DESKTOP);
        conn.setRequestProperty("Accept", "*/*");
        // 强制不压缩：源站对 KEY 也可能返回 gzip（无 Content-Encoding 头），拿到必是乱码
        conn.setRequestProperty("Accept-Encoding", "identity");
        if (referer != null) conn.setRequestProperty("Referer", referer);
        try {
            int code = conn.getResponseCode();
            String ct = String.valueOf(conn.getContentType());
            if (code != 200) {
                diag.append("KEY ").append(shortUrl(url)).append(" → HTTP ").append(code).append('\n');
                throw new java.io.IOException("KEY 请求失败 HTTP " + code + "（" + shortUrl(url) + "）");
            }
            byte[] body;
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192];
                int k;
                while ((k = in.read(buf)) > 0) {
                    bo.write(buf, 0, k);
                    if (bo.size() > KEY_MAX_BYTES) throw new java.io.IOException("KEY 响应体超限（>" + KEY_MAX_BYTES + "B），不是密钥");
                }
                body = bo.toByteArray();
            }
            body = maybeInflate(body);
            if (body.length == KEY_LEN) return body;
            diag.append("KEY ").append(shortUrl(url))
                    .append(" → bytes=").append(body.length)
                    .append(" ct=").append(ct)
                    .append(" head=").append(hexPreview(body, 64))
                    .append(looksLikeM3u8(body) ? " [疑似 m3u8 播放列表]"
                            : looksLikeHtml(body) ? " [疑似 HTML/风控页]" : "")
                    .append('\n');
            throw new java.io.IOException("KEY 不是 16 字节（len=" + body.length + "，源站返回的不是 AES 密钥）");
        } finally {
            conn.disconnect();
        }
    }

    /** 解包本站/源站的 huangguo-proxy 包装，拿到真实目标地址。 */
    private static String unwrapProxyUrl(String url) {
        try {
            int q = url.indexOf("/api/huangguo-proxy?");
            if (q < 0) return url;
            String qs = url.substring(q + "/api/huangguo-proxy?".length());
            for (String kv : qs.split("&")) {
                int e = kv.indexOf('=');
                if (e <= 0 || !"url".equals(kv.substring(0, e))) continue;
                String v = kv.substring(e + 1);
                for (int i = 0; i < 3; i++) {   // 源站有时双层编码
                    String d = java.net.URLDecoder.decode(v, "UTF-8");
                    if (d.equals(v)) break;
                    v = d;
                }
                return v;
            }
        } catch (Exception ignored) {}
        return url;
    }

    /** gzip/deflate 魔数兜底解压（源站偶发无视 Accept-Encoding 返回压缩体）。 */
    private static byte[] maybeInflate(byte[] b) {
        if (b == null || b.length < 4) return b;
        try {
            if ((b[0] & 0xFF) == 0x1f && (b[1] & 0xFF) == 0x8b) {
                try (java.util.zip.GZIPInputStream gz = new java.util.zip.GZIPInputStream(new java.io.ByteArrayInputStream(b))) {
                    ByteArrayOutputStream o = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int k;
                    while ((k = gz.read(buf)) > 0) o.write(buf, 0, k);
                    return o.toByteArray();
                }
            }
            if ((b[0] & 0xFF) == 0x78) {
                try (java.util.zip.InflaterInputStream inf = new java.util.zip.InflaterInputStream(new java.io.ByteArrayInputStream(b))) {
                    ByteArrayOutputStream o = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int k;
                    while ((k = inf.read(buf)) > 0) o.write(buf, 0, k);
                    return o.toByteArray();
                }
            }
        } catch (Exception ignored) {}
        return b;
    }

    private static boolean looksLikeM3u8(byte[] b) {
        if (b == null || b.length < 7) return false;
        try { return new String(b, 0, Math.min(b.length, 16), StandardCharsets.UTF_8).startsWith("#EXTM3U"); }
        catch (Exception e) { return false; }
    }

    private static boolean looksLikeHtml(byte[] b) {
        if (b == null || b.length == 0) return false;
        String s = new String(b, 0, Math.min(b.length, 64), StandardCharsets.UTF_8).trim().toLowerCase();
        return s.startsWith("<") || s.contains("<html") || s.contains("<!doctype") || s.startsWith("{");
    }

    /** 诊断用：前 n 字节的十六进制 + 可打印预览（HTML/m3u8 一眼能认出来）。 */
    private static String hexPreview(byte[] b, int n) {
        if (b == null) return "";
        int len = Math.min(b.length, n);
        StringBuilder hex = new StringBuilder();
        StringBuilder txt = new StringBuilder();
        for (int i = 0; i < len; i++) {
            int v = b[i] & 0xFF;
            hex.append(String.format(Locale.US, "%02x", v));
            txt.append(v >= 32 && v < 127 ? (char) v : '.');
        }
        if (b.length > len) hex.append("…");
        return "hex=" + hex + " txt=" + txt;
    }

    /** TS 判定：首字节必须是 sync byte 0x47，长度够时再按 188/192/204 包长二次校验（防 1/256 误判）。 */
    private static boolean looksLikeTs(byte[] b) {
        if (b == null || b.length < 1) return false;
        if ((b[0] & 0xFF) != 0x47) return false;
        if (b.length <= 188) return true;
        return (b.length > 188 && (b[188] & 0xFF) == 0x47)
                || (b.length > 192 && (b[192] & 0xFF) == 0x47)
                || (b.length > 204 && (b[204] & 0xFF) == 0x47);
    }

    private static byte[] readHead(File f, int n) {
        byte[] buf = new byte[n];
        try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) {
            int off = 0;
            while (off < n) {
                int k = fis.read(buf, off, n - off);
                if (k <= 0) break;
                off += k;
            }
            if (off == n) return buf;
            byte[] r = new byte[off];
            System.arraycopy(buf, 0, r, 0, off);
            return r;
        } catch (Exception e) {
            return new byte[0];
        }
    }

    /**
     * 削掉 AES-128-CBC(NoPadding) 解密后残留的 PKCS#7 填充。
     *
     * HLS 分片是「明文 + PKCS#7 填充」再按 16 字节块加密的，所以密文长度是 16 的倍数，
     * 明文长度却不是。用 NoPadding 解密拿到的是「明文 + 填充」，填充长度记在最后一个字节，
     * 值是 pad 字节、每个字节都是 pad。实测每个分片尾部残留 4~16 字节（如 04040404、
     * 10101010...0x10×16），削掉之后分片长度才正好是 188 的整数倍。
     *
     * 只在「削完正好是 188 的整数倍」时才认定是填充 —— 否则万一源站真的把 0x04 写进了
     * 有效数据，这个判据能避免削掉真数据。不符合就原样返回，不做任何破坏。
     */
    private static byte[] stripPkcs7Pad(byte[] b) {
        if (b == null || b.length < 188 + 1) return b;
        int n = b.length;
        int pad = b[n - 1] & 0xFF;
        if (pad < 1 || pad > 16 || pad >= n) return b;
        for (int i = n - pad; i < n; i++) if ((b[i] & 0xFF) != pad) return b;
        int keep = n - pad;
        if (keep % 188 != 0) return b;       // 削完不能整除 188 → 不是填充，别动
        byte[] r = new byte[keep];
        System.arraycopy(b, 0, r, 0, keep);
        return r;
    }

    /**
     * 产物「画面」自检：真的解几帧出来看，而不是只查容器。
     *
     * 黑屏有两种形态，只看容器都发现不了：
     *   1) 视频轨时长为 0（FFmpegConcat.verify 已覆盖）；
     *   2) 时长/结构全部正常，但解码器不认这条轨（典型是 stsd 写了 avc3/hev1，
     *      或者样本数据被旧的 annex-b→长度前缀转换弄坏）→ 播放器打开黑屏。
     * 第 2 种只能靠实际取帧判断。
     *
     * @return 0=正常（解出非纯色画面）；1=取不到帧（无法判定，只记日志不拦截）；
     *         2=取到的帧全是纯色/全黑（确定黑屏）。
     * 注意不要把 1 当失败：个别机型 / 某些编码上 MediaMetadataRetriever 会返回 null，
     * 那属于「判不了」，拦下来只会把能播的剧也判死。
     */
    private static int checkPicture(File out, StringBuilder dbg) {
        if (out == null || !out.exists() || out.length() == 0) return 1;
        android.media.MediaMetadataRetriever mr = new android.media.MediaMetadataRetriever();
        try {
            mr.setDataSource(out.getAbsolutePath());
            long durMs = 0;
            try {
                String ds = mr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION);
                if (ds != null) durMs = Long.parseLong(ds.trim());
            } catch (Exception ignored) {}
            if (durMs <= 0) { dbg.append("[画面自检] 读不到时长\n"); return 1; }
            long[] pts = { durMs * 15 / 100, durMs * 50 / 100, durMs * 85 / 100 };
            int got = 0, blank = 0;
            for (long t : pts) {
                android.graphics.Bitmap bm = null;
                try {
                    bm = mr.getFrameAtTime(t * 1000L,
                            android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                } catch (Exception ignored) {}
                if (bm == null) continue;
                got++;
                if (isBlankFrame(bm)) blank++;
                try { bm.recycle(); } catch (Exception ignored) {}
            }
            dbg.append("[画面自检] 时长=").append(durMs).append("ms 取到帧=").append(got)
                    .append(" 纯色帧=").append(blank).append('\n');
            if (got == 0) return 1;
            return blank == got ? 2 : 0;
        } catch (Exception e) {
            dbg.append("[画面自检] 异常：").append(e).append('\n');
            return 1;
        } finally {
            try { mr.release(); } catch (Exception ignored) {}
        }
    }

    /**
     * 抽稀采样判断是否「平坦帧」（黑屏 / 纯色 / 无画面）。
     *
     * 判据用**亮度极差**而不是「颜色是否完全相同」：真黑屏经过 H.264 压缩后每个像素都有
     * 细微噪声，颜色极少完全相等，用相等判据会漏判。正常影视画面在 24×24 个采样点上
     * 亮度极差普遍 > 60，而纯黑/纯色帧极差 < 20，两者区分度足够。
     */
    private static boolean isBlankFrame(android.graphics.Bitmap bm) {
        try {
            int w = bm.getWidth(), h = bm.getHeight();
            if (w <= 0 || h <= 0) return true;
            int sx = Math.max(1, w / 24), sy = Math.max(1, h / 24);
            int lo = 255, hi = 0, total = 0;
            for (int y = 0; y < h; y += sy) {
                for (int x = 0; x < w; x += sx) {
                    int p = bm.getPixel(x, y);
                    // 整数近似亮度：0.299R + 0.587G + 0.114B
                    int r = (p >> 16) & 0xFF, g = (p >> 8) & 0xFF, b = p & 0xFF;
                    int y8 = (r * 77 + g * 150 + b * 29) >> 8;
                    if (y8 < lo) lo = y8;
                    if (y8 > hi) hi = y8;
                    total++;
                }
            }
            if (total == 0) return true;
            return (hi - lo) < 20;
        } catch (Exception e) {
            return false;   // 读像素失败不判黑屏，避免误杀
        }
    }

    /** 复用本地 work 前检查：playlist 里引用的 KEY 文件必须都存在且为 16 字节，否则删掉坏的并返回说明
     *  （调用方据此放弃本地复用、重新解析下载）。没有 KEY 行（明文剧）返回 null。 */
    private static String dropInvalidLocalKeys(File work, File playlist) {
        try {
            String text = new String(java.nio.file.Files.readAllBytes(playlist.toPath()), StandardCharsets.UTF_8);
            java.util.regex.Matcher km = java.util.regex.Pattern.compile("URI=\"([^\"]+)\"").matcher("");
            java.util.LinkedHashSet<String> names = new java.util.LinkedHashSet<>();
            for (String raw : text.split("\r?\n")) {
                String line = raw.trim();
                if (!line.startsWith("#EXT-X-KEY") || line.contains("METHOD=NONE")) continue;
                km.reset(line);
                if (km.find()) names.add(km.group(1));
            }
            StringBuilder bad = new StringBuilder();
            for (String k : names) {
                File kf = new File(work, k);
                boolean missing = !kf.exists();
                long len = missing ? -1 : kf.length();
                if (missing || len != KEY_LEN) {
                    if (!missing) kf.delete();
                    if (bad.length() > 0) bad.append('、');
                    bad.append(k).append(missing ? " 缺失" : " len=" + len);
                }
            }
            return bad.length() == 0 ? null : bad.toString();
        } catch (Exception e) {
            return null;   // playlist 读不了就交给后面的合并流程报错
        }
    }

    /** 密文分片但 KEY 不可用时的错误信息：带上 KEY 下载阶段的诊断，直接说明源站返回了什么。 */
    private static String keyUnavailableMessage(File work, String segName, String keyName, Map<String, Integer> badLen) {
        StringBuilder sb = new StringBuilder();
        sb.append("分片不是明文且没有可用 KEY: ").append(segName);
        if (keyName == null) {
            sb.append("（playlist 未给该分片配 KEY，源可能未加密但分片内容异常）");
        } else {
            Integer len = badLen == null ? null : badLen.get(keyName);
            sb.append("（KEY=").append(keyName)
              .append(len == null ? " 未下载" : (len < 0 ? " 文件缺失" : " len=" + len))
              .append("，合法 AES-128 密钥必须是 16 字节）");
        }
        try {
            File d = new File(work, "key-diag.txt");
            if (d.exists() && d.length() > 0) {
                String t = new String(java.nio.file.Files.readAllBytes(d.toPath()), StandardCharsets.UTF_8).trim();
                if (t.length() > 600) t = t.substring(0, 600) + "…";
                if (!t.isEmpty()) sb.append("\nKEY 诊断:\n").append(t);
            }
        } catch (Exception ignored) {}
        return sb.toString();
    }

    /** 黄果 m3u8 下载：展开 → 拉 KEY/分片（并发）→ 本地 playlist → ffmpeg remux mp4 → 清理。
     *  临时文件放每集独立子目录（多集并发时不互相覆盖），产物最终落到 out。 */
    private void downloadM3u8(Task task, String url, File out, AtomicLong dlBytes, AtomicLong totalBytes, int n) throws Exception {
        File work = new File(out.getParentFile(), "m3u8-w" + n);
        work.mkdirs();
        boolean segOk = false;
        File playlist = new File(work, "play.m3u8");
        // 关键：分片/KEY/本地 playlist 早已下载好时（上次合并失败/中断），直接跳过解析与下载进合并——
        // 不重新拉源 master（源/代理卡死时也能合并），合并不依赖源站。
        // 本地复用前提：playlist 存在，且它引用的 KEY 文件（若有）都是 16 字节合法密钥。
        // 历史 bug：只要 playlist 非空就复用 → 之前下到的坏 KEY 永久留在 work 目录，
        // 每次重试都跳过下载直接进合并 → 每集都报同一个"KEY 文件异常"，重试完全无效。
        boolean haveLocal = playlist.exists() && playlist.length() > 0;
        if (haveLocal) {
            String bad = dropInvalidLocalKeys(work, playlist);
            if (bad != null) {
                // 有坏 KEY：删掉并强制重新解析下载（重走 fetchKeyBytes 的严格 16 字节校验）
                haveLocal = false;
                task.debug = "第 " + n + " 集：本地 KEY 损坏已删除（" + bad + "），重新解析并下载 KEY";
            }
        }
        try {
            if (haveLocal) {
                task.detail = "第 " + n + " 集：本地分片已就绪，直接合并…";
                task.debug = "第 " + n + " 集：复用本地分片（playlist+ts+key 齐全），跳过解析与下载";
            } else {
            List<String> segUris = new ArrayList<>();
            List<String> segKeys = new ArrayList<>();
            List<String> segIVs = new ArrayList<>();
            AtomicInteger mediaSeqRef = new AtomicInteger(0);   // 源真实媒体序列号（无显式 IV 分片的默认 IV 基准）
            expandCount = 0;   // 每集重置解析计数
            task.detail = "解析 m3u8 播放列表…";
            task.debug = "第 " + n + " 集：解析 m3u8 播放列表…";
            // 解析放独立子线程 + 90s 硬超时：黄果源 master 是变种列表（子流套子流），
            // 递归展开可能数百个串行请求，无超时保护会永久卡死在"解析 m3u8 播放列表…"
            ExecutorService expandPool = Executors.newSingleThreadExecutor();
            try {
                Future<?> fe = expandPool.submit(() -> {
                    try { expandM3u8(url, segUris, segKeys, segIVs, 0, task, n, mediaSeqRef); }
                    catch (Throwable t) { throw new RuntimeException(t); }
                });
                try {
                    fe.get(90, TimeUnit.SECONDS);
                } catch (TimeoutException te) {
                    fe.cancel(true);
                    throw new java.io.IOException("第 " + n + " 集 m3u8 解析超时（90s），请重试");
                }
            } finally { expandPool.shutdownNow(); }
            if (segUris.isEmpty()) throw new java.io.IOException("m3u8 无分片");
            task.detail = "解析完成，共 " + segUris.size() + " 个分片，开始下载";
            task.debug = "第 " + n + " 集：m3u8 含 " + segUris.size() + " 个分片，开始下载";
            // 去重 KEY → 本地 key 文件。KEY 必须是严格 16 字节（见 fetchKeyBytes）：不足/超长/像 HTML/像
            // m3u8 一律判失败，且失败绝不落盘（历史 bug：11545 字节的风控页被当成密钥存下，又因"非空即
            // 已下载"永久复用，导致每集都报同一个 KEY 异常）。
            // 拿不到 KEY 不在这里中断下载——分片可能本来就是明文，不需要 KEY；真正遇到密文分片在合并阶段报错。
            LinkedHashMap<String, String> keyNames = new LinkedHashMap<>();
            StringBuilder keyDiag = new StringBuilder();
            {
                int keyIdx = 0;
                for (int i = 0; i < segKeys.size(); i++) {
                    String ku = segKeys.get(i);
                    if (ku == null || keyNames.containsKey(ku)) continue;
                    String kname = "key-" + keyIdx + ".key";
                    File kf = new File(work, kname);
                    // KEY 复用：只有 16 字节的合法密钥才复用；长度不对一律删掉重下
                    if (kf.exists() && kf.length() != KEY_LEN) {
                        keyDiag.append("丢弃历史坏 KEY ").append(kname).append(" len=").append(kf.length()).append('\n');
                        kf.delete();
                    }
                    if (!(kf.exists() && kf.length() == KEY_LEN)) {
                        kf.delete();
                        try {
                            java.nio.file.Files.write(kf.toPath(), fetchKeyBytes(ku, keyDiag));
                        } catch (Exception ke) {
                            keyDiag.append("KEY 下载失败 ").append(kname).append(": ").append(ke.getMessage()).append('\n');
                        }
                    }
                    // 不论下载成败都登记文件名：playlist 里仍然写真实 key 文件名（不写 METHOD=NONE），
                    // 这样万一分片本来是明文照样能过（合并阶段按需取 KEY），真遇到密文时错误信息能指名道姓
                    keyNames.put(ku, kname);
                    keyIdx++;
                }
                if (keyDiag.length() > 0) {
                    // 诊断落盘一份（文件管理器可查），同时进 debug，用户能直接看到源站到底返回了什么
                    try {
                        java.nio.file.Files.write(new File(work, "key-diag.txt").toPath(),
                                keyDiag.toString().getBytes(StandardCharsets.UTF_8));
                    } catch (Exception ignored) {}
                    task.debug = (task.debug == null ? "" : task.debug + "\n")
                            + "[KEY] " + keyDiag.toString().trim().replace('\n', ' ');
                }
            }
            // 并发下载分片（8 并发：多集任务并发后对源/代理压力可控，过高易触发 502/限流）
            final int segN = segUris.size();
            final String[] segFiles = new String[segN];
            final AtomicInteger nextSeg = new AtomicInteger();
            final AtomicInteger segDone = new AtomicInteger();   // 真正完成的片数（进度精确，不再用"已分配"误导）
            final AtomicLong lastBytes = new AtomicLong();
            final AtomicLong lastTime = new AtomicLong(System.currentTimeMillis());
            ExecutorService pool = Executors.newFixedThreadPool(Math.min(8, Math.max(1, segN)));
            List<Future<?>> futs = new ArrayList<>();
            for (int i = 0; i < Math.min(8, segN); i++) {
                futs.add(pool.submit(() -> {
                    int curIdx = -1;
                    try {
                        while (!task.canceled) {
                            int idx = nextSeg.getAndIncrement();
                            if (idx >= segN) break;
                            curIdx = idx;
                            // 先显示"正在下载第 X/N 片"，卡住时用户能看出在等哪一片（避免误判成合并卡）
                            task.detail = "下载中 第 " + (idx + 1) + "/" + segN + " 片…";
                            task.debug = "第 " + n + " 集：正在下载第 " + (idx + 1) + "/" + segN + " 片…";
                            String name = String.format(Locale.US, "seg-%04d.ts", idx);
                            File segFile = new File(work, name);
                            // 分片复用：重试时已存在且非空的分片直接跳过（合并失败保留的 ts 不再重复下载）
                            if (!(segFile.exists() && segFile.length() > 0)) {
                                // 先写 .part 再改名：下载超时/断流留下的半截 ts 不会被下次当成"完整分片"复用
                                // （半截 ts 会被判为已下载 → 产物缺尾/解密校验失败，而且永远自愈不了）
                                File part = new File(work, name + ".part");
                                try {
                                    downloadToFile(segUris.get(idx), part, dlBytes, totalBytes);
                                    if (!part.renameTo(segFile)) {
                                        java.nio.file.Files.copy(part.toPath(), segFile.toPath(),
                                                java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                                    }
                                } finally {
                                    if (part.exists()) part.delete();
                                }
                            }
                            segFiles[idx] = name;
                            // 进度=真正完成片数（精确），并显示实时下载速度
                            int done = segDone.incrementAndGet();
                            long now = System.currentTimeMillis();
                            long lb = lastBytes.getAndSet(dlBytes.get());
                            long lt = lastTime.getAndSet(now);
                            long dt = now - lt;
                            double mbps = dt > 0 ? (dlBytes.get() - lb) / 1024.0 / 1024.0 / (dt / 1000.0) : 0;
                            task.detail = String.format(Locale.US, "下载中 已完成 %d/%d 片 · %.1fMB/s", done, segN, mbps);
                            task.debug = "第 " + n + " 集：已完成 " + done + "/" + segN + " 片"
                                + String.format(Locale.US, " · %.1fMB/s", mbps);
                        }
                    } catch (Exception e) {
                        throw new RuntimeException("第 " + (curIdx + 1) + "/" + segN + " 片下载失败: " + e.getMessage(), e);
                    }
                }));
            }
            try {
                Exception firstErr = null;
                for (Future<?> f : futs) {
                    try { f.get(); } catch (Exception e) { if (firstErr == null) firstErr = e.getCause() instanceof Exception ? (Exception) e.getCause() : e; }
                }
                if (firstErr != null) throw firstErr;
            } finally {
                pool.shutdownNow();
            }
            if (task.canceled) {
                task.debug = "第 " + n + " 集：任务已取消，跳过合并";
                return;
            }
            for (int i = 0; i < segN; i++) {
                if (segFiles[i] == null) throw new java.io.IOException("分片下载不完整（第 " + (i + 1) + "/" + segN + " 片缺失）");
                File sf = new File(work, segFiles[i]);
                if (!sf.exists() || sf.length() == 0) throw new java.io.IOException("分片文件无效（第 " + (i + 1) + "/" + segN + " 片大小异常）");
            }
            // 本地 playlist（相对路径；每段按需写 KEY 行，合并阶段从本地 playlist 自解析 AES-128 解密）
            {
                StringBuilder sb = new StringBuilder("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:").append(mediaSeqRef.get()).append("\n");
                String lastKeyName = null;
                String lastIV = "";
                for (int i = 0; i < segN; i++) {
                    String ku = segKeys.get(i);
                    String kn = ku != null ? keyNames.get(ku) : null;
                    // 逐片 IV：同一个 KEY 下不同分片可能带不同显式 IV，按 (KEY, IV) 变化才写 KEY 行。
                    // 旧实现按 KEY URL 去重、只写一次 IV，第 2 片起的显式 IV 全被丢掉 → 解密错。
                    String iv = (i < segIVs.size() && segIVs.get(i) != null) ? segIVs.get(i) : "";
                    if (kn == null) {
                        // 该段源上就没有 KEY（METHOD=NONE）：显式写 NONE 把上一段的 KEY 关掉，
                        // 否则解析本地 playlist 时会沿用上一段的密钥去解明文分片
                        if (lastKeyName != null) {
                            sb.append("#EXT-X-KEY:METHOD=NONE\n");
                            lastKeyName = null;
                            lastIV = "";
                        }
                    } else if (!kn.equals(lastKeyName) || !iv.equals(lastIV)) {
                        sb.append("#EXT-X-KEY:METHOD=AES-128,URI=\"").append(kn).append("\"");
                        // 源显式 IV 原样保留（IV=0x...）；缺失则不写，由解析器用媒体序列号算默认 IV
                        if (!iv.isEmpty()) sb.append(",IV=").append(iv);
                        sb.append('\n');
                        lastKeyName = kn;
                        lastIV = iv;
                    }
                    sb.append("#EXTINF:4.0,\n").append(segFiles[i]).append('\n');
                }
                sb.append("#EXT-X-ENDLIST\n");
                java.nio.file.Files.write(playlist.toPath(), sb.toString().getBytes(StandardCharsets.UTF_8));
            }
            }   // else：本地已有 playlist → 跳过解析/下载，直接进合并
            // 下载/复用后：把密文 TS 统一解密为明文（TS 文件可直接播放；合并检测 0x47 直接用明文）
            try { decryptTsToPlain(work, playlist, task, n); } catch (Exception de) { /* 解密失败保留密文，合并时再试 */ }
            // ---- 调试模式（私密模式「下载到手机（调试）」）：素材到此为止，不合并 ----
            // 目的是拿到「出问题那一集」的原封素材（ts + key + playlist + 诊断），导成一个 zip
            // 落在公共 Downloads，用户直接转发即可。导出成功后 work 才清（zip 里已是全部内容，
            // 不必在手机上存两份 ts）。
            if (task.keepRaw) {
                task.detail = "第 " + n + " 集：调试模式，打包 TS/KEY…";
                try {
                    String where = exportDebugBundle(task, work, n);
                    task.debug = "第 " + n + " 集：调试模式已导出 " + where + "（未合并）";
                    segOk = true;   // 打包完成 → 允许 finally 清掉内部 work
                } catch (Exception ee) {
                    task.debug = "第 " + n + " 集：调试包导出失败（TS 仍保留在本机任务目录）：" + ee;
                }
                return;
            }
            StringBuilder dbg = new StringBuilder();
            // 合并产物直接写最终路径（无 .tmp 改名落位步骤）：MediaMuxer 写完 out 即产物，
            // 杜绝"合并完成但产物未落位"（rename/copy 在 Android 上不可靠）。半成品由重试覆盖。
            File tmpOut = out;
            // 方案2（无 ffmpeg）：Cipher 解密 ts → full.ts 字节拼接 → MediaExtractor/MediaMuxer 重封装。
            // 合并完全基于本地 work（play.m3u8 + ts + key），不依赖源站；独立子线程 + 120s 硬超时。
            task.detail = "第 " + n + " 集合并中…";
            task.debug = "第 " + n + " 集：解密合并中…";
            ExecutorService remuxPool = Executors.newSingleThreadExecutor();
            // 合并超时按分片总量动态放宽：长剧的单集能到 300MB+/165 片，Muxer 逐样本写入要跑一两分钟，
            // 固定 120s 会把「其实能成功」的集判成超时（用户看到的就是合并失败）
            long workBytes = 0;
            File[] workFiles = work.listFiles();
            if (workFiles != null) for (File wf : workFiles) if (wf.isFile() && wf.getName().endsWith(".ts")) workBytes += wf.length();
            int timeoutSec = (int) Math.min(600, Math.max(120, 90 + workBytes / (1024 * 1024) / 2));
            try {
                Future<?> fr = remuxPool.submit(() -> {
                    try { mergeTsToMp4(work, tmpOut, dbg); }
                    catch (Throwable t) { throw new RuntimeException(t); }
                });
                try {
                    fr.get(timeoutSec, TimeUnit.SECONDS);
                } catch (TimeoutException te) {
                    fr.cancel(true);
                    // 超时也要留合并日志，用户能看卡在哪
                    task.error = "第 " + n + " 集 m3u8 合并超时（" + timeoutSec + "s）\n" + dbg;
                    task.debug = "第 " + n + " 集：合并超时（" + timeoutSec + "s），详见合并日志";
                    throw new java.io.IOException("第 " + n + " 集 m3u8 合并超时（" + timeoutSec + "s），请重试");
                } catch (java.util.concurrent.ExecutionException ee) {
                    // 合并失败：把 m3u8ToMp4 详细日志写进任务，不再让 debug 残留下载阶段的"已完成 X/Y 片"
                    Throwable cause = ee.getCause() != null ? ee.getCause() : ee;
                    task.error = "第 " + n + " 集合并失败: " + cause + "\n" + dbg;
                    task.debug = "第 " + n + " 集：合并失败，详见合并日志";
                    throw new RuntimeException(cause);
                }
            } finally { remuxPool.shutdownNow(); }
            // 产物移动/落位/清理全带分段日志与异常兜底：任何一步慢/失败都不让任务永久卡在"合并中"
            // 注意：tmpOut == out（合并直接写最终路径），无改名步骤，成功即落位
            if (out.exists() && out.length() >= 1024) {
                segOk = true;   // 本集合并成功，产物已落位
                task.debug = "第 " + n + " 集：合并完成（产物 " + out.length() + "B）";
            } else {
                // 产物为空/缺失：多半是本集分片是旧版错误 IV 下载的乱码（或下载不完整）。
                // 清掉本地 playlist+ts 强制重新解析下载，避免反复合并空产物死循环
                task.debug = "第 " + n + " 集：合并产物无效，清理本集旧分片，再点重试将重新下载";
                try { deleteRecursively(work); } catch (Exception ignored) { }
                throw new java.io.IOException("第 " + n + " 集合并产物无效，旧分片已清理，请再次重试");
            }
        } finally {
            // 合并成功后清理本集临时目录（ts/KEY/playlist/半成品）；失败保留 ts，
            // 文件管理器可见已下载分片（下多少存多少，与后端落盘一致）
            if (segOk) {
                try { deleteRecursively(work); } catch (Exception ignored) {}
            }
        }
    }

    // ---- 调试包（私密模式「下载到手机（调试）」）----

    private static final String DEBUG_README =
        "Veyra 单集调试包\r\n"
        + "==================\r\n"
        + "这是某一集的原始素材，**没有合并成 mp4**，用于排查「合并后黑屏 / 花屏 / 时长不对」这类问题。\r\n\r\n"
        + "包含：\r\n"
        + "  seg-XXXX.ts   已下载并解密（若源为 AES-128）的原始分片，可直接播放\r\n"
        + "  key-N.key     源站返回的 AES-128 密钥原文（16 字节）\r\n"
        + "  play.m3u8     本地重写的播放列表（分片顺序 + KEY/IV 对应关系）\r\n"
        + "  key-diag.txt  仅当密钥下载异常时出现，记录源站实际返回内容\r\n"
        + "  diag.txt      分片逐个体检：TS 同步字节、annex-b 起始码长度分布、NAL 类型、音视频轨信息\r\n\r\n"
        + "关键看 diag.txt 里的「起始码 3B / 4B」：3 字节起始码（00 00 01）的 TS 在部分播放器 / 封装器上\r\n"
        + "会被误判，正是「容器合法但画面全黑」的典型来源。\r\n";

    /** 把一集的 work 目录（ts/KEY/playlist/诊断）整包打成一个 zip 导出到公共 Downloads。
     *  @return 便于写进任务日志的「落在哪 / 多大」描述 */
    private String exportDebugBundle(Task task, File work, int n) throws Exception {
        File[] kids = work.listFiles();
        if (kids == null || kids.length == 0) throw new java.io.IOException("调试目录为空，没有可导出的分片");
        // 诊断与说明先落进 work，随后一起打进 zip
        java.nio.file.Files.write(new File(work, "diag.txt").toPath(),
                buildDebugDiag(task, work, n).getBytes(StandardCharsets.UTF_8));
        java.nio.file.Files.write(new File(work, "README.txt").toPath(),
                DEBUG_README.getBytes(StandardCharsets.UTF_8));

        String subDir = task.title == null ? "" : task.title.replaceAll("[\\\\/:*?\"<>|]", "_");
        String zipName = String.format(Locale.US, "第%02d集_调试包.zip", n);
        File tmp = new File(work.getParentFile(), "dbg_" + n + ".zip");
        if (tmp.exists()) tmp.delete();
        File[] all = work.listFiles();
        if (all == null) throw new java.io.IOException("调试目录不可读");
        java.util.Arrays.sort(all, (a, b) -> a.getName().compareTo(b.getName()));
        byte[] buf = new byte[256 * 1024];
        try (java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(
                new java.io.BufferedOutputStream(new FileOutputStream(tmp), 1024 * 1024))) {
            for (File f : all) {
                if (!f.isFile()) continue;
                // mpeg-ts 基本不可再压缩，deflate 只会白白多花一倍 CPU 时间 → 全部 STORED
                java.util.zip.ZipEntry e = new java.util.zip.ZipEntry(f.getName());
                e.setMethod(java.util.zip.ZipEntry.STORED);
                e.setSize(f.length());
                e.setCompressedSize(f.length());
                e.setCrc(crc32(f));
                e.setTime(f.lastModified());
                zos.putNextEntry(e);
                try (InputStream in = new FileInputStream(f)) {
                    int r;
                    while ((r = in.read(buf)) > 0) zos.write(buf, 0, r);
                }
                zos.closeEntry();
            }
        }
        long size = tmp.length();
        Uri u;
        try {
            u = exportToDownloads(tmp, subDir, zipName, "application/zip");
        } finally {
            tmp.delete();
        }
        return zipName + " " + (size / 1024 / 1024) + "MB" + (u == null ? "" : " → " + u);
    }

    private static long crc32(File f) throws Exception {
        java.util.zip.CRC32 crc = new java.util.zip.CRC32();
        byte[] buf = new byte[256 * 1024];
        try (InputStream in = new FileInputStream(f)) {
            int r;
            while ((r = in.read(buf)) > 0) crc.update(buf, 0, r);
        }
        return crc.getValue();
    }

    /** 分片逐个体检：这是排查「黑屏」最直接的一手材料，比事后看 mp4 更准。 */
    private String buildDebugDiag(Task task, File work, int n) {
        StringBuilder sb = new StringBuilder();
        String ver = "";
        try { ver = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName; } catch (Exception ignored) {}
        sb.append("# Veyra 单集调试包诊断\n");
        sb.append("appVersion=").append(ver).append('\n');
        sb.append("source=").append(task.source).append('\n');
        sb.append("title=").append(task.title).append('\n');
        sb.append("episode=").append(n).append('\n');
        sb.append("time=").append(new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
                .format(new java.util.Date())).append('\n');
        sb.append("device=").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
                .append(" / Android ").append(Build.VERSION.RELEASE).append('\n');

        File[] segs = work.listFiles((d, name) -> name.endsWith(".ts"));
        if (segs == null) segs = new File[0];
        java.util.Arrays.sort(segs, (a, b) -> a.getName().compareTo(b.getName()));
        long bytes = 0;
        for (File s : segs) bytes += s.length();
        sb.append("\n## 分片 ").append(segs.length).append(" 个，共 ").append(bytes / 1024 / 1024).append("MB\n");
        for (int i = 0; i < segs.length; i++) sb.append(probeSegment(segs[i], i == 0 || i == segs.length - 1)).append('\n');

        sb.append("\n## 音视频轨（MediaExtractor 读首片）\n");
        if (segs.length > 0) {
            try {
                MediaExtractor ex = openExtractor(segs[0]);
                try {
                    for (int t = 0; t < ex.getTrackCount(); t++) {
                        MediaFormat mf = ex.getTrackFormat(t);
                        sb.append("track").append(t).append(": ").append(mf.getString(MediaFormat.KEY_MIME));
                        Integer w = mf.containsKey(MediaFormat.KEY_WIDTH) ? mf.getInteger(MediaFormat.KEY_WIDTH) : null;
                        Integer h = mf.containsKey(MediaFormat.KEY_HEIGHT) ? mf.getInteger(MediaFormat.KEY_HEIGHT) : null;
                        if (w != null && h != null) sb.append(' ').append(w).append('x').append(h);
                        ByteBuffer csd = mf.getByteBuffer("csd-0");
                        sb.append(" csd-0=").append(csd == null ? "缺失" : csd.remaining() + "B");
                        sb.append('\n');
                    }
                } finally { try { ex.release(); } catch (Exception ignored) {} }
            } catch (Exception e) {
                sb.append("MediaExtractor 打不开首片：").append(e).append('\n');
            }
        }

        sb.append("\n## KEY\n");
        File[] keys = work.listFiles((d, name) -> name.endsWith(".key"));
        if (keys == null || keys.length == 0) sb.append("无（分片可能是明文）\n");
        else for (File k : keys) {
            sb.append(k.getName()).append(" len=").append(k.length()).append(" hex=");
            try { sb.append(hex(java.nio.file.Files.readAllBytes(k.toPath()), 32)); }
            catch (Exception e) { sb.append('<').append(e).append('>'); }
            sb.append('\n');
        }

        sb.append("\n## 本地 playlist\n");
        File pl = new File(work, "play.m3u8");
        try { sb.append(new String(java.nio.file.Files.readAllBytes(pl.toPath()), StandardCharsets.UTF_8)); }
        catch (Exception e) { sb.append("<读取失败 ").append(e).append(">\n"); }
        return sb.toString();
    }

    /** 单片体检：TS 同步字节 + annex-b 起始码 3B/4B 统计 + NAL 类型分布（只扫前 1MB，够判断）。 */
    private static String probeSegment(File f, boolean verbose) {
        StringBuilder r = new StringBuilder();
        r.append(f.getName()).append(' ').append(f.length()).append('B');
        long sc3 = 0, sc4 = 0;
        int[] nalType = new int[64];
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[1024 * 1024];
            int len = in.read(b);
            if (len <= 0) return r.append(" 读取失败").toString();
            int first = b[0] & 0xFF;
            r.append(" 首字节=0x").append(String.format(Locale.US, "%02X", first));
            if (first != 0x47) r.append("（不是 TS 同步字节！）");
            for (int i = 0; i + 4 < len; i++) {
                if (b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1) {
                    if (i > 0 && b[i - 1] == 0) sc4++; else sc3++;
                    int h = b[i + 3] & 0xFF;
                    if (h < 64) nalType[h]++;
                }
            }
        } catch (Exception e) {
            return r.append(" 读取异常:").append(e).toString();
        }
        r.append(" 起始码 3B=").append(sc3).append(" 4B=").append(sc4);
        if (!verbose) return r.toString();
        // 只对首末片印 NAL 类型分布，避免 diag 被几百行刷爆
        r.append(" NAL类型{");
        boolean any = false;
        for (int t = 0; t < nalType.length; t++) {
            if (nalType[t] == 0) continue;
            if (any) r.append(',');
            r.append(t).append(':').append(nalType[t]);
            any = true;
        }
        return r.append('}').toString();
    }

    private static String hex(byte[] b, int max) {
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < b.length && i < max; i++) s.append(String.format(Locale.US, "%02x", b[i]));
        return s.toString();
    }

    /** 下载完成后把密文 TS 解密为明文（0x47 开头）：TS 文件可直接播放（用户要求"之前版本可播"），
     *  合并也直接用明文（mergeTsToMp4 检测 0x47 跳过再解密）。已明文的片跳过；解密失败保留密文
     *  （合并时再尝试），不阻塞下载。IV 规则与 mergeTsToMp4 一致（显式 IV / mediaSeq 大端 fallback）。 */
    private static void decryptTsToPlain(File work, File playlist, Task task, int n) throws Exception {
        String text = new String(java.nio.file.Files.readAllBytes(playlist.toPath()), StandardCharsets.UTF_8);
        List<String> segNames = new ArrayList<>();
        List<String> segKeys = new ArrayList<>();
        List<String> segIVs = new ArrayList<>();
        int mediaSeq = 0;
        String curKey = null, curIV = "";
        java.util.regex.Matcher km = java.util.regex.Pattern.compile("URI=\"([^\"]+)\"").matcher("");
        java.util.regex.Matcher im = java.util.regex.Pattern.compile("IV=([0-9a-fA-Fx]+)").matcher("");
        for (String raw : text.split("\r?\n")) {
            String line = raw.trim();
            if (line.startsWith("#EXT-X-KEY")) {
                km.reset(line); curKey = km.find() ? km.group(1) : null;
                im.reset(line); curIV = im.find() ? im.group(1) : "";
            } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
                int p = line.indexOf(':');
                if (p >= 0) { try { mediaSeq = Integer.parseInt(line.substring(p + 1).trim()); } catch (Exception ignored) {} }
            } else if (!line.isEmpty() && !line.startsWith("#")) {
                segNames.add(line); segKeys.add(curKey); segIVs.add(curIV);
            }
        }
        Map<String, byte[]> keyBytes = new HashMap<>();
        for (String k : segKeys) {
            if (k == null || keyBytes.containsKey(k)) continue;
            File kf = new File(work, k);
            // 只有 16 字节才是合法 AES-128 密钥；其他长度（源站 HTML/风控页）一律不参与解密
            if (kf.exists() && kf.length() == KEY_LEN) keyBytes.put(k, java.nio.file.Files.readAllBytes(kf.toPath()));
        }
        int decOk = 0;
        int decBad = 0;
        int total = segNames.size();
        for (int i = 0; i < total; i++) {
            File seg = new File(work, segNames.get(i));
            if (!seg.exists() || seg.length() == 0) continue;
            byte[] head = readHead(seg, 376);
            // 已明文（TS sync byte 0x47，并二次校验第 188 字节）：直接跳过，避免重复解密把明文再解一次
            if (looksLikeTs(head)) { decOk++; continue; }
            byte[] key = keyBytes.get(segKeys.get(i));
            if (key == null || key.length != KEY_LEN) continue;
            // 逐片进度：65 片大分片解密可达 1-2 分钟，无进度会被误判成卡死
            if (task != null) {
                task.detail = "第 " + n + " 集解密 " + (i + 1) + "/" + total + " 片…";
                task.debug = "第 " + n + " 集：解密 " + (i + 1) + "/" + total + " 片…";
            }
            try {
                byte[] enc = java.nio.file.Files.readAllBytes(seg.toPath());
                Cipher c = Cipher.getInstance("AES/CBC/NoPadding");
                c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(ivForSeg(segIVs, i, mediaSeq)));
                byte[] dec = c.doFinal(enc);
                // 解出来的必须是明文 TS 才覆盖原文件：IV/KEY 不对时解出的垃圾一旦写回，密文就被永久毁掉，
                // 下次再解密等于二次解密 → 整集报废且无法自愈（旧实现缺这层校验，直接回写）
                if (!looksLikeTs(dec)) { decBad++; continue; }
                // NoPadding 解密保留源站加的 PKCS#7 填充（实测每片尾部残留 4~16 字节，
                // 内容是「填充长度」重复），这里削掉，让落盘的 TS 正好是 188 的整数倍，
                // 文件管理器里能直接播，也免得把垃圾字节带进合并阶段。
                dec = stripPkcs7Pad(dec);
                java.nio.file.Files.write(seg.toPath(), dec);
                decOk++;
            } catch (Exception ignored) {}
        }
        if (task != null) {
            task.detail = "第 " + n + " 集解密完成 " + decOk + "/" + total + " 片";
            task.debug = "第 " + n + " 集：解密完成 " + decOk + "/" + total + " 片"
                    + (decBad > 0 ? "（" + decBad + " 片解出非 TS 数据，已保留密文待合并阶段重判）" : "");
        }
    }

    /** 方案2（libffconcat.so FFmpeg concat）：Cipher AES-128-CBC 解密每个 ts → 明文分片列表 →
     *  FFmpeg concat（-c copy 无损重封装）出单集 mp4（avc3/hev1 in-band SPS/PPS，与后端
     *  server/downloader.js 同款逻辑，B 帧 PTS/ctts/参数集全部由 FFmpeg 处理）。
     *  HLS 标准：分片 16 字节对齐，NoPadding 解密；显式 IV 按分片（segIVs），无显式 IV 时
     *  用媒体序列号（mediaSeq+i 大端 16B）。输入仅依赖本地 work 目录：从 play.m3u8 自解析
     *  分片/KEY/IV/序列号，完全不需要源站，分片早已下载好时（合并失败重试）直接合并。
     *  成功后删明文 ts；失败保留可重试。 */
    private static void mergeTsToMp4(File work, File out, StringBuilder dbg) throws Exception {
        long t0 = System.currentTimeMillis();
        dbg.append("方案2：Cipher 解密 + FFmpeg concat 合并\n");
        File playlist = new File(work, "play.m3u8");
        if (!playlist.exists()) throw new java.io.IOException("缺少本地 playlist（play.m3u8）");
        String text = new String(java.nio.file.Files.readAllBytes(playlist.toPath()), StandardCharsets.UTF_8);
        // 从本地 playlist 解析：分片相对路径 / 当前 KEY URI / 显式 IV / MEDIA-SEQUENCE
        List<String> segNames = new ArrayList<>();
        List<String> segKeys = new ArrayList<>();
        List<String> segIVs = new ArrayList<>();
        int mediaSeq = 0;
        String curKey = null, curIV = "";
        java.util.regex.Matcher km = java.util.regex.Pattern.compile("URI=\"([^\"]+)\"").matcher("");
        java.util.regex.Matcher im = java.util.regex.Pattern.compile("IV=([0-9a-fA-Fx]+)").matcher("");
        for (String raw : text.split("\r?\n")) {
            String line = raw.trim();
            if (line.startsWith("#EXT-X-KEY")) {
                km.reset(line);
                curKey = km.find() ? km.group(1) : null;
                im.reset(line);
                curIV = im.find() ? im.group(1) : "";
            } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
                int p = line.indexOf(':');
                if (p >= 0) {
                    try { mediaSeq = Integer.parseInt(line.substring(p + 1).trim()); } catch (Exception ignored) {}
                }
            } else if (!line.isEmpty() && !line.startsWith("#")) {
                segNames.add(line);
                segKeys.add(curKey);
                segIVs.add(curIV);
            }
        }
        if (segNames.isEmpty()) throw new java.io.IOException("playlist 无分片");
        dbg.append("本地 playlist: ").append(segNames.size()).append(" 片\n");
        // 1) KEY 字节（KEY URI 相对 work，16B）。
        //    这里不做"缺失/长度不对就直接抛"的强制校验：分片可能本来就是明文（不需要 KEY），
        //    旧实现先无条件校验 KEY，导致"KEY 坏 + 分片明文"的集也被判失败。改成按需取用，
        //    真遇到密文分片、而它对应的 KEY 不可用时才报错（错误信息里带源站返回内容的诊断）。
        Map<String, byte[]> keyBytes = new HashMap<>();
        Map<String, Integer> keyBadLen = new HashMap<>();
        for (String k : segKeys) {
            if (k == null || keyBytes.containsKey(k) || keyBadLen.containsKey(k)) continue;
            File kf = new File(work, k);
            if (!kf.exists() || kf.length() == 0) { keyBadLen.put(k, -1); continue; }
            byte[] kb = java.nio.file.Files.readAllBytes(kf.toPath());
            if (kb.length != KEY_LEN) { keyBadLen.put(k, kb.length); continue; }
            keyBytes.put(k, kb);
        }
        // 2) 逐片解密 → 单分片明文 ts（dec-%04d.ts）。不拼接 full.ts：
        //    字节拼接后 Android MediaExtractor 只解析第一分片（后续分片 PAT/PMT 或 PID 变化被忽略），
        //    实测产物只有前几秒；每个分片独立 ts（自带 PAT/PMT/SPS/PPS），单独解析可靠。
        dbg.append("逐片解密 ").append(segNames.size()).append(" 片…\n");
        File[] decFiles = new File[segNames.size()];
        try {
            for (int i = 0; i < segNames.size(); i++) {
                File seg = new File(work, segNames.get(i));
                if (!seg.exists() || seg.length() == 0) throw new java.io.IOException("分片缺失: " + segNames.get(i));
                byte[] enc = java.nio.file.Files.readAllBytes(seg.toPath());
                byte[] dec;
                // 已明文（下载后 decryptTsToPlain 解密过）→ 直接复用；密文才走 Cipher
                if (looksLikeTs(enc)) {
                    dec = enc;
                } else {
                    byte[] key = keyBytes.get(segKeys.get(i));
                    if (key == null) throw new java.io.IOException(keyUnavailableMessage(work, segNames.get(i), segKeys.get(i), keyBadLen));
                    byte[] iv = ivForSeg(segIVs, i, mediaSeq);
                    try {
                        Cipher c = Cipher.getInstance("AES/CBC/NoPadding");
                        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
                        dec = c.doFinal(enc);
                    } catch (Exception ce) {
                        throw new java.io.IOException("分片解密失败 " + segNames.get(i) + ": " + ce);
                    }
                    // 解密结果校验：必须是明文 TS（0x47 + 第 188 字节二次校验）。不是 → IV/KEY 与源不符
                    if (!looksLikeTs(dec)) {
                        throw new java.io.IOException("分片解密结果无效 " + segNames.get(i)
                            + "（IV/KEY 与源不符，需重新下载本集）");
                    }
                }
                File df = new File(work, String.format(Locale.US, "dec-%04d.ts", i));
                // 老版本落盘的分片带 PKCS#7 填充尾巴，这里兜底再削一次（已是 188 整数倍则原样返回）
                java.nio.file.Files.write(df.toPath(), stripPkcs7Pad(dec));
                decFiles[i] = df;
            }
        } catch (Exception e) {
            for (File df : decFiles) if (df != null) df.delete();
            throw e;
        }

        // 3) 合并。顺序：libffconcat（FFmpeg concat）优先 → 失败才回退系统 MediaMuxer。
        //    ⚠️ v0.18.68~0.18.72 是反着的（muxer 优先），导致【部分源】的单集产物「能播、有时长、
        //    画面全黑」：TS 里的 H.264 样本是 annex-b，其中不少源用 3 字节起始码（00 00 01），
        //    MediaMuxer 做 annex-b→长度前缀转换时只认 4 字节（00 00 00 01），样本整体错位 →
        //    mdat 里没有一个能解的 NAL → 播放器黑屏，而 moov/stbl 结构完全合法，verify 也查不出来。
        //    FFmpeg concat 自己按 annex-b 解析（3/4 字节都认），0.18.67 全量可播的正是这条路径。
        //    首片视频编码 → tag（回退 native 时用）。
        // ⚠️ 必须用 avc1 / hvc1，不能用 avc3 / hev1。
        // 两者的区别是「参数集（SPS/PPS）放在哪」：
        //   avc1 → 参数集只在 avcC box 里（out-of-band），这是 Android 解码器 / 系统播放器
        //          / 相册唯一稳定支持的形态，MediaMuxer 产出的也是它；
        //   avc3 → 参数集在样本里（in-band），规范上合法，ffmpeg 也能正确生成，
        //          但大量 Android 硬件解码器按四码匹配 stsd，遇到 avc3 直接判为不支持 →
        //          播放器打开就是黑屏（有声音或有进度条、画面全黑），且容器结构完全合法，
        //          任何基于容器的校验都查不出来。
        // v0.18.76 及以前这里写的是 avc3，正是「某些剧单集黑屏、合集却正常」的来源：
        // 合集走 MediaMuxer（avc1）能播，单集走 native（avc3）黑屏。
        String tag = "avc1";
        try {
            MediaExtractor ex = openExtractor(decFiles[0]);
            try {
                for (int t = 0; t < ex.getTrackCount(); t++) {
                    String mime = ex.getTrackFormat(t).getString(MediaFormat.KEY_MIME);
                    if (mime != null && mime.startsWith("video/hevc")) { tag = "hvc1"; break; }
                }
            } finally { try { ex.release(); } catch (Exception ignored) {} }
        } catch (Exception ignored) {}
        File nativeLog = new File(work, "native-concat.log");
        try {
            boolean merged = false;
            try {
                dbg.append("libffconcat（FFmpeg concat）合并 ").append(decFiles.length).append(" 片…\n");
                // 必须先删掉旧产物：native 侧是「存在即不覆盖」的打开方式，重试时残留的
                // 上一次（可能是黑屏的）成品会让 native 直接失败并回退到 muxer，问题被掩盖。
                if (out.exists() && !out.delete()) dbg.append("警告：旧产物删不掉，继续尝试合并\n");
                FFmpegConcat.concat(java.util.Arrays.asList(decFiles), null, out, tag, dbg, nativeLog);
                // 画面自检：容器合法、时长正确但画面全黑，是「stsd 写了 avc3」这类问题的典型形态，
                // 只查容器查不出来，必须真的解一帧看。确定黑屏就删掉产物走 muxer 兜底。
                if (checkPicture(out, dbg) == 2)
                    throw new java.io.IOException("产物抽帧全是纯色/全黑（打开会黑屏）");
                merged = true;
            } catch (Throwable natErr) {
                dbg.append("libffconcat 合并失败：").append(natErr).append('\n');
                if (out.exists()) out.delete();
            }
            if (!merged) {
                // 兜底：native 库加载不了 / 崩溃时才走这条路。注意它对「3 字节起始码的 TS」会产黑屏，
                // 所以必须再过一遍 verify（视频轨时长 ≤ 0 直接判失败，不让坏文件落盘）
                dbg.append("回退系统 muxer 合并 ").append(decFiles.length).append(" 片…\n");
                concatTsByMuxer(decFiles, out, dbg);
                FFmpegConcat.verify(out, java.util.Arrays.asList(decFiles), dbg);
                if (checkPicture(out, dbg) == 2)
                    throw new java.io.IOException("回退 muxer 合并后抽帧仍是纯色/全黑（打开会黑屏）");
            }
            dbg.append("合并完成 ").append(out.length()).append("B 耗时 ").append((System.currentTimeMillis() - t0) / 1000).append("s\n");
        } finally {
            // 明文分片是临时文件（每片 2~3MB，165 片就是几百 MB），无论成败都清掉
            for (File df : decFiles) if (df != null) df.delete();
        }
    }

    // ---- 纯 Java 分片 concat（MediaExtractor + MediaMuxer）----
    /** 每片统计：本片视频相对时长 / 帧间隔 / 写入样本数。 */
    private static final class SegStat {
        long maxV, vDelta;
        int samples;
    }

    private static MediaExtractor openExtractor(File f) throws Exception {
        MediaExtractor ex = new MediaExtractor();
        ex.setDataSource(f.getAbsolutePath());
        return ex;
    }

    /**
     * 分片级 concat（纯 Java）。用于私密模式（黄果）ts 分片：
     *   逐片 MediaExtractor 读样本 → MediaMuxer 顺序写入，时间轴按「本片首样本 + 累计偏移」重排。
     * 相比 libffconcat 的 -c copy，这里由系统 muxer 生成 stsd/stsz/stco/stss 与 avcC/hvcC，
     * 产物必然能被 MediaExtractor / 系统播放器识别（native 产物曾出现「有音频轨、没有视频轨」）。
     * 视频保持解码序写入，PTS 只做单调化修正——**这是它的固有缺陷**：MediaMuxer 不接受写入序上
     * 时间戳回退，而 B 帧在解码序里 PTS 必然回退（I P B B → 0,4,1,2），只能抬到「上一个 +1µs」，
     * 呈现时间就被压平了（实测 66.9% 的样本被改写，出画按解码序、整段发顿）。
     * 所以它只作兜底：正常路径走 libffconcat（-c copy 保留源 ctts，B 帧关系完整）。
     * 音频按本片视频时长截断，避免逐片累积音画错位。
     */
    private static void concatTsByMuxer(File[] decFiles, File out, StringBuilder dbg) throws Exception {
        MediaFormat vf = null, af = null;
        int vIdx = -1, aIdx = -1;
        MediaExtractor probe = openExtractor(decFiles[0]);
        try {
            for (int t = 0; t < probe.getTrackCount(); t++) {
                MediaFormat f = probe.getTrackFormat(t);
                if (f == null) continue;
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime == null) continue;
                if (vIdx < 0 && mime.startsWith("video/")) { vIdx = t; vf = f; }
                else if (aIdx < 0 && mime.startsWith("audio/")) { aIdx = t; af = f; }
            }
        } finally { try { probe.release(); } catch (Exception ignored) {} }
        if (vIdx < 0 || vf == null) throw new java.io.IOException("首片没有视频轨，无法合并");
        String vmime = vf.getString(MediaFormat.KEY_MIME);
        if (!vf.containsKey("csd-0")) ensureCodecSpecificData(vf, collectSamples(openExtractor(decFiles[0]), vIdx), vmime);
        if (!vf.containsKey("csd-0")) throw new java.io.IOException("首片提取不到视频参数集(csd)，无法用 muxer 合并");
        if (af != null && !af.containsKey("csd-0")) {
            ByteBuffer asc = extractAacAsc(decFiles[0], aIdx);
            if (asc == null) asc = buildAacAsc(af);
            if (asc != null) af.setByteBuffer("csd-0", asc);
        }

        MediaMuxer muxer = null;
        boolean started = false;
        try {
            if (out.exists()) out.delete();          // 覆盖上次失败留下的残片
            muxer = new MediaMuxer(out.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            int vt = muxer.addTrack(vf);
            int at = af != null ? muxer.addTrack(af) : -1;
            muxer.start();
            started = true;
            long[] vLast = {-1}, aLast = {-1};
            boolean hevc = vmime != null && vmime.startsWith("video/hevc");
            long offset = 0;
            int written = 0, used = 0, skipped = 0;
            for (int i = 0; i < decFiles.length; i++) {
                SegStat st = writeSegment(decFiles[i], muxer, vt, at, offset, vLast, aLast, hevc);
                if (st.samples <= 0) { skipped++; continue; }
                used++;
                written += st.samples;
                offset += Math.max(0, st.maxV) + Math.max(0, st.vDelta);
            }
            if (written <= 0) throw new java.io.IOException("所有分片都没有可写入的样本");
            dbg.append("muxer 写入 ").append(used).append('/').append(decFiles.length).append(" 片 样本 ")
                    .append(written).append(" 时长 ").append(offset / 1000).append("ms")
                    .append(skipped > 0 ? "（跳过 " + skipped + " 片空片）" : "").append('\n');
        } finally {
            if (muxer != null) {
                if (started) { try { muxer.stop(); } catch (Exception ignored) {} }
                try { muxer.release(); } catch (Exception ignored) {}
            }
        }
        if (!out.exists() || out.length() == 0) throw new java.io.IOException("muxer 产物为空");
    }

    /** 单片写入：视频整轨（解码序）+ 音频按本片视频时长截断；时间戳跨片绝对单调。 */
    private static SegStat writeSegment(File f, MediaMuxer muxer, int vTrack, int aTrack,
                                        long offset, long[] vLast, long[] aLast, boolean hevc) throws Exception {
        SegStat st = new SegStat();
        int vi = -1, ai = -1;
        MediaExtractor probe = openExtractor(f);
        try {
            for (int t = 0; t < probe.getTrackCount(); t++) {
                MediaFormat fm = probe.getTrackFormat(t);
                if (fm == null) continue;
                String mime = fm.getString(MediaFormat.KEY_MIME);
                if (mime == null) continue;
                if (vi < 0 && mime.startsWith("video/")) vi = t;
                else if (ai < 0 && mime.startsWith("audio/")) ai = t;
            }
        } finally { try { probe.release(); } catch (Exception ignored) {} }
        if (vi < 0) return st;
        List<Sample> vs = collectSamples(openExtractor(f), vi);
        if (vs.isEmpty()) return st;
        List<Sample> as = ai >= 0 ? collectSamples(openExtractor(f), ai) : new ArrayList<Sample>();

        long base = vs.get(0).pts;
        if (!as.isEmpty()) base = Math.min(base, as.get(0).pts);

        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long prev = -1;
        int k = 0;
        for (Sample s : vs) {
            long t = s.pts - base + offset;
            if (t < 0) t = 0;
            if (t <= vLast[0]) t = vLast[0] + 1;
            if (k > 0) {
                long d = t - prev;
                if (d > 0 && d < 200_000L) st.vDelta = Math.max(st.vDelta, d);   // 帧间隔（用于补片尾）
            }
            vLast[0] = t;
            if (t > st.maxV) st.maxV = t;
            prev = t;
            k++;
            // TS 源 MediaExtractor 不报同步帧标志 → 自己从 NAL 头判（IDR / 参数集），
            // 否则 muxer 写不出 stss，播放器 seek/切换码率会从非关键帧解码 → 花屏、乱码
            long flags = s.flags;
            if ((flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) == 0
                    && (sampleIsSync(s.data, 0, (int) Math.min(s.size, 4096), hevc) || k == 1))
                flags |= MediaCodec.BUFFER_FLAG_KEY_FRAME;
            writeSample(muxer, vTrack, t, s.size, flags, s.data, info);
            st.samples++;
        }
        st.maxV = st.maxV - offset;                        // 转成本片相对时长
        long maxRel = st.maxV + st.vDelta;
        for (Sample s : as) {
            long rel = s.pts - base;
            if (rel > maxRel) continue;                     // 音频截断到本片视频时长
            long t = rel + offset;
            if (t < 0) t = 0;
            if (t <= aLast[0]) t = aLast[0] + 1;
            aLast[0] = t;
            writeSample(muxer, aTrack, t, s.size, s.flags, s.data, info);
            st.samples++;
        }
        return st;
    }

    /** 无 ADTS 头可读时，按轨道的采样率/声道数兜底构造 AAC-LC 的 AudioSpecificConfig。 */
    private static ByteBuffer buildAacAsc(MediaFormat af) {
        try {
            int sr = af.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? af.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 44100;
            int ch = af.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? af.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 2;
            int[] rates = {96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350};
            int sf = 4;
            for (int i = 0; i < rates.length; i++) if (rates[i] == sr) { sf = i; break; }
            byte[] asc = new byte[2];
            asc[0] = (byte) ((2 << 3) | (sf >> 1));          // objectType=2 (AAC-LC)
            asc[1] = (byte) (((sf & 1) << 7) | (ch << 3));
            ByteBuffer bb = ByteBuffer.wrap(asc);
            bb.position(0);
            return bb;
        } catch (Exception ignored) {
            return null;
        }
    }

    /** 产物 MP4 盒子结构快照（诊断用）：顶层盒子 + moov 内每条 trak 的 stsd 样本描述。 */
    private static String dumpMp4Boxes(File f) {
        StringBuilder sb = new StringBuilder();
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "r")) {
            long len = raf.length();
            byte[] head = new byte[16];
            raf.seek(0);
            long pos = 0;
            int guard = 0;
            while (pos + 8 <= len && guard++ < 32) {
                raf.seek(pos);
                if (raf.read(head) < 8) break;
                long size = ((head[0] & 0xFFL) << 24) | ((head[1] & 0xFFL) << 16) | ((head[2] & 0xFFL) << 8) | (head[3] & 0xFFL);
                String type = new String(head, 4, 4, StandardCharsets.ISO_8859_1);
                sb.append(type).append('(').append(size).append(") ");
                if (size <= 1) break;
                if ("moov".equals(type) && pos + size <= len) {
                    sb.append(trakSummary(raf, pos + 8, pos + size));
                }
                pos += size;
            }
        } catch (Exception e) {
            sb.append("dump失败:").append(e.getMessage());
        }
        return sb.toString().trim();
    }

    /** 在 moov 内找 trak，输出每条 trak 的 stsd 首样本描述四码（avc1/hvc1/avc3/hev1/mp4a…）。 */
    private static String trakSummary(java.io.RandomAccessFile raf, long start, long end) {
        StringBuilder sb = new StringBuilder();
        try {
            byte[] b = new byte[16];
            long pos = start;
            while (pos + 8 <= end) {
                raf.seek(pos);
                if (raf.read(b) < 8) break;
                long size = ((b[0] & 0xFFL) << 24) | ((b[1] & 0xFFL) << 16) | ((b[2] & 0xFFL) << 8) | (b[3] & 0xFFL);
                String type = new String(b, 4, 4, StandardCharsets.ISO_8859_1);
                if (size < 8) break;
                if ("trak".equals(type)) {
                    String codec = findStsd(raf, pos + 8, Math.min(pos + size, end));
                    sb.append("[trak:").append(codec == null ? "无stsd?" : codec).append("] ");
                }
                pos += size;
            }
        } catch (Exception ignored) { }
        return sb.toString();
    }

    private static String findStsd(java.io.RandomAccessFile raf, long start, long end) {
        try {
            byte[] b = new byte[16];
            long pos = start;
            int guard = 0;
            while (pos + 8 <= end && guard++ < 64) {
                raf.seek(pos);
                if (raf.read(b) < 8) return null;
                long size = ((b[0] & 0xFFL) << 24) | ((b[1] & 0xFFL) << 16) | ((b[2] & 0xFFL) << 8) | (b[3] & 0xFFL);
                String type = new String(b, 4, 4, StandardCharsets.ISO_8859_1);
                if (size < 8) return null;
                if ("stsd".equals(type)) {
                    raf.seek(pos + 16);                       // 8 头 + 4 version/flags + 4 entry_count
                    byte[] e = new byte[8];
                    if (raf.read(e) < 8) return null;
                    return new String(e, 4, 4, StandardCharsets.ISO_8859_1);
                }
                if ("mdia".equals(type) || "minf".equals(type) || "stbl".equals(type) || "trak".equals(type)) {
                    String r = findStsd(raf, pos + 8, Math.min(pos + size, end));
                    if (r != null) return r;
                }
                pos += size;
            }
        } catch (Exception ignored) { }
        return null;
    }

    private static byte[] ivForSeg(List<String> segIVs, int i, int mediaSeq) {
        String ivs = (i < segIVs.size()) ? segIVs.get(i) : null;
        if (ivs != null && !ivs.isEmpty()) {
            String h = ivs.replace("0x", "").replace("0X", "");
            if (h.length() == 32) {
                byte[] b = new byte[16];
                for (int k = 0; k < 16; k++) b[k] = (byte) Integer.parseInt(h.substring(k * 2, k * 2 + 2), 16);
                return b;
            }
        }
        long seq = ((long) mediaSeq) + i;
        byte[] b = new byte[16];
        for (int k = 15; k >= 0; k--) { b[k] = (byte) (seq & 0xff); seq >>>= 8; }
        return b;
    }

    /** 检测视频样本是否为同步样本（IDR/参数集）。TS 源 MediaExtractor 不提供 sync 信息，
     *  MediaMuxer 需要 BUFFER_FLAG_KEY_FRAME 才能写出 stss（否则播放器不知道关键帧位置，
     *  缓存切换/丢帧后从非关键帧解码 → 间歇乱码/花屏）。
     *  NAL 可为 annex-b（00 00 01 / 00 00 00 01 起始）或 length-prefixed（4 字节大端长度起始）。 */
    private static boolean sampleIsSync(ByteBuffer buf, int off, int size, boolean hevc) {
        if (size < 6) return false;
        byte[] h = new byte[8];
        for (int i = 0; i < Math.min(8, size); i++) h[i] = buf.get(off + i);
        int pos = 0;
        if (h[0] == 0 && h[1] == 0 && h[2] == 1) pos = 3;
        else if (h[0] == 0 && h[1] == 0 && h[2] == 0 && h[3] == 1) pos = 4;
        else {
            long len = ((h[0] & 0xFFL) << 24) | ((h[1] & 0xFFL) << 16) | ((h[2] & 0xFFL) << 8) | (h[3] & 0xFFL);
            if (len > 0 && len <= size - 4) pos = 4;
        }
        if (pos + 1 > size) return false;
        int t = buf.get(off + pos) & 0xFF;
        if (hevc) {
            int nt = (t >> 1) & 0x3f;
            return (nt >= 16 && nt <= 23) || nt == 32 || nt == 33 || nt == 34;  // IRAP / VPS / SPS / PPS
        }
        int nt = t & 0x1f;
        return nt == 5 || nt == 7 || nt == 8;   // IDR / SPS / PPS
    }

    /** 从音频轨首个 ADTS 帧头构造 AudioSpecificConfig（MediaMuxer addTrack 需要 csd-0）。 */
    private static ByteBuffer extractAacAsc(File file, int track) throws Exception {
        MediaExtractor ex = new MediaExtractor();
        try {
            ex.setDataSource(file.getAbsolutePath());
            ex.selectTrack(track);
            while (ex.advance()) {
                long sz = ex.getSampleSize();
                if (sz < 7) continue;
                ByteBuffer bb = ByteBuffer.allocate((int) Math.min(sz, 1024));
                int n = ex.readSampleData(bb, 0);
                if (n < 7) continue;
                byte[] h = new byte[4];
                bb.position(0); bb.get(h);
                if ((h[0] & 0xff) != 0xff || (h[1] & 0xf0) != 0xf0) continue;   // 非 ADTS sync
                int profile = (h[2] & 0xc0) >> 6;                     // objectType - 1
                int sfIdx = (h[2] & 0x3c) >> 2;                        // samplingFrequencyIndex
                int chCfg = ((h[2] & 0x01) << 2) | ((h[3] & 0xc0) >> 6); // channelConfiguration
                int objectType = profile + 1;
                byte[] asc = new byte[2];
                asc[0] = (byte) ((objectType << 3) | (sfIdx >> 1));
                asc[1] = (byte) (((sfIdx & 1) << 7) | (chCfg << 3));
                ByteBuffer out = ByteBuffer.wrap(asc);
                out.position(0);
                return out;
            }
            return null;
        } finally { ex.release(); }
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursively(c);
        f.delete();
    }

    // ---- MediaExtractor + MediaMuxer 合并 ----
    // ---- MediaExtractor + MediaMuxer 合并（每集全量收集 → 保持解码序 → 整轨写入）----
    // H.264 含 B 帧时，样本必须按解码顺序（extractor 原始顺序）写入 mp4，
    // B 帧的 PTS 偏移由 MediaMuxer 内部写 ctts 处理；绝不能按 PTS 重排样本
    // （会破坏解码引用顺序 → 灰屏/花屏）。mp4 允许视频轨与音频轨样本不交错，
    // 因此每集先整轨写视频、再整轨写音频。
    private static final class Sample {
        final long pts;
        final long size;
        final long flags;
        final ByteBuffer data;
        Sample(long pts, long size, long flags, ByteBuffer data) {
            this.pts = pts; this.size = size; this.flags = flags; this.data = data;
        }
    }

    private static List<Sample> collectSamples(MediaExtractor ex, int track) {
        ex.selectTrack(track);
        List<Sample> out = new ArrayList<>();
        while (ex.advance()) {
            long pts = ex.getSampleTime();
            long size = ex.getSampleSize();
            long flags = ex.getSampleFlags();
            if (size <= 0) continue;
            ByteBuffer buf = ByteBuffer.allocate((int) size);
            int n = ex.readSampleData(buf, 0);
            if (n <= 0) continue;   // 读取失败的样本直接跳过，绝不把垃圾数据交给 muxer
            buf.position(0);
            buf.limit(n);
            out.add(new Sample(pts, n, flags, buf));
        }
        try { ex.release(); } catch (Exception ignored) {}
        return out;
    }

    /** 单样本写入 muxer（复用 BufferInfo）。 */
    private static void writeSample(MediaMuxer muxer, int track, long t, long size, long flags, ByteBuffer data, MediaCodec.BufferInfo info) {
        ByteBuffer buffer = data.duplicate();
        info.offset = 0;
        info.size = (int) size;
        info.presentationTimeUs = t;
        info.flags = (int) flags;
        muxer.writeSampleData(track, buffer, info);
    }

    /** 音视频按写入时间交错归并（等价 ffmpeg 输出交错，mdat 内视频/音频块交替排布，seek 友好）。
     *  视频轨保持解码序（列表顺序）不被归并打乱，仅决定与音频的穿插；
     *  音频按 aMaxRel 截断（相对 aBase，对齐视频时长）；传 -1 不截断。
     *  返回 {视频maxT, 音频maxT}（相对各自 offset）。 */
    private static long[] writeInterleaved(MediaMuxer muxer, int vTrack, int aTrack,
            List<Sample> vSamples, List<Sample> aSamples,
            long vBase, long vOffset, long aBase, long aOffset,
            long[] vLastRef, long[] aLastRef, long aMaxRel) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long lastV = vLastRef[0], lastA = aLastRef[0], maxV = 0, maxA = 0;
        int vi = 0, ai = 0;
        while (vi < vSamples.size() || ai < aSamples.size()) {
            boolean takeV;
            if (vi >= vSamples.size()) takeV = false;
            else if (ai >= aSamples.size()) takeV = true;
            else {
                long vT = vSamples.get(vi).pts - vBase + vOffset; if (vT < 0) vT = 0; if (vT <= lastV) vT = lastV + 1;
                long aT = aSamples.get(ai).pts - aBase + aOffset; if (aT < 0) aT = 0; if (aT <= lastA) aT = lastA + 1;
                takeV = vT <= aT;
            }
            if (takeV) {
                Sample s = vSamples.get(vi++);
                long t = s.pts - vBase + vOffset;
                if (t < 0) t = 0;
                if (t <= lastV) t = lastV + 1;
                lastV = t; if (t > maxV) maxV = t;
                writeSample(muxer, vTrack, t, s.size, s.flags, s.data, info);
            } else {
                Sample s = aSamples.get(ai++);
                long rel = s.pts - aBase;
                if (aMaxRel >= 0 && rel > aMaxRel) continue;
                long t = rel + aOffset;
                if (t < 0) t = 0;
                if (t <= lastA) t = lastA + 1;
                lastA = t; if (t > maxA) maxA = t;
                writeSample(muxer, aTrack, t, s.size, s.flags, s.data, info);
            }
        }
        vLastRef[0] = lastV; aLastRef[0] = lastA;
        return new long[]{maxV, maxA};
    }

    /** 流式单轨游标（归并用）：按解码序推进，PTS 单调化，保留当前样本供比较。
     *  注意：构造时必须 selectTrack——MediaExtractor 默认读轨道 0，红果分集第 0 轨常为音频，
     *  不选轨会把音频样本当成视频样本读，导致产物视频轨为空（合并报"分集没有视频轨道"）。 */
    private static final class Cursor {
        final MediaExtractor ex;
        final long base;
        final int muxTrack;
        long t, size, flags;
        ByteBuffer buffer;
        ByteBuffer reusable;
        boolean eof;
        private long lastT = Long.MIN_VALUE;
        Cursor(MediaExtractor ex, int track, long base, int muxTrack) {
            this.ex = ex; this.base = base; this.muxTrack = muxTrack;
            ex.selectTrack(track);
        }
        void advance() throws java.io.IOException {
            if (eof) return;
            while (ex.advance()) {
                long sz = ex.getSampleSize();
                if (sz <= 0) continue;
                if (reusable == null || reusable.capacity() < sz) reusable = ByteBuffer.allocate((int) Math.max(sz, 1 << 18));   // 复用缓冲，避免每样本 allocate
                reusable.clear();
                int n = ex.readSampleData(reusable, 0);
                if (n <= 0) continue;
                reusable.position(0); reusable.limit(n);
                long tt = ex.getSampleTime() - base;
                if (tt < 0) tt = 0;
                if (tt <= lastT) tt = lastT + 1;
                lastT = tt;
                this.t = tt; this.size = n; this.flags = ex.getSampleFlags(); this.buffer = reusable;
                return;
            }
            eof = true;
        }
    }

    /** 音视频各自归零基准 + 按时间交错写入（流式版，normalizeEpisode 用）。
     *  等价 ffmpeg -c copy 单集输出：视频从 0 起、音频从 0 起、mdat 交错。 */
    private static void writeInterleavedStream(File file, int vTrack, int aTrack, MediaMuxer muxer,
            int vMux, int aMux, long vBase, long aBase) throws Exception {
        MediaExtractor vx = new MediaExtractor();
        vx.setDataSource(file.getAbsolutePath());
        Cursor vc = new Cursor(vx, vTrack, vBase, vMux);
        vc.advance();
        Cursor ac = null;
        if (aTrack >= 0) {
            MediaExtractor ax = new MediaExtractor();
            ax.setDataSource(file.getAbsolutePath());
            ac = new Cursor(ax, aTrack, aBase, aMux);
            ac.advance();
        }
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (!vc.eof || (ac != null && !ac.eof)) {
            boolean takeV;
            if (vc.eof) takeV = false;
            else if (ac == null || ac.eof) takeV = true;
            else takeV = vc.t <= ac.t;
            Cursor c = takeV ? vc : ac;
            writeSample(muxer, c.muxTrack, c.t, c.size, c.flags, c.buffer, info);
            c.advance();
        }
        try { vx.release(); } catch (Exception ignored) {}
    }

    /** 按解码序整轨写入样本，返回本轨最大 PTS（相对 offset）。
     *  H.264 含 B 帧时解码序的 PTS 会摆动（B 帧 PTS < 相邻 P 帧），部分设备 MediaMuxer 要求时间戳单调，
     *  直接写会抛 writeSampleData returned an error。做法：物理顺序保持解码序，只把回退的时间戳
     *  单调化（抬到不早于前一样本）——解码引用顺序不受影响（画面正常），B 帧呈现仅滞后 1µs（无感知）。
     *  lastTRef[0] 为跨集持久的上一样本时间戳（每轨独立），保证多集合并时时间戳绝对单调。
     *  maxRel 为本集相对时长上限（相对 base）；样本相对时间超过上限直接跳过——用于音频按视频时长
     *  截断，与后端转码 `-t 视频时长` 对齐：红果每集视频轨比音频轨短（视频首样本 PTS≈533333µs、音频≈0），
     *  若音频不截断，音视频轨时长差会逐集累积，合并产物 seek 后音画错位（画面快进追赶、声音乱码）。
     *  传 -1 表示不截断（视频轨）。 */
    private static long writeSamples(MediaMuxer muxer, int track, List<Sample> samples, long base, long offset, long[] lastTRef, long maxRel) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long lastT = lastTRef[0];
        long maxT = 0;
        for (Sample s : samples) {
            long rel = s.pts - base;
            if (maxRel >= 0 && rel > maxRel) continue;   // 截断（音频对齐视频时长）
            ByteBuffer buffer = s.data.duplicate();
            info.offset = 0;
            info.size = (int) s.size;
            long t = rel + offset;
            if (t < 0) t = 0;
            if (t <= lastT) t = lastT + 1;   // PTS 单调化（解码序保持，仅修正回退）
            info.presentationTimeUs = t;
            info.flags = (int) s.flags;
            muxer.writeSampleData(track, buffer, info);
            lastT = t;
            if (t > maxT) maxT = t;
        }
        lastTRef[0] = lastT;
        return maxT;
    }

    /** @param keys 与 inputs 一一对应的解密密钥（空串 = 明文，已解密的正式分集都传空串）。 */
    private void mergeMp4(List<File> inputs, List<String> keys, File output, Task task) throws Exception {
        StringBuilder debug = new StringBuilder("合并详细日志\n分集数=").append(inputs.size()).append('\n');
        String stage = "初始化";
        java.util.List<File> decryptTmp = new java.util.ArrayList<>();
        try {
            // 0 集保护：分集列表为空（如旧版本任务未持久化 episodes 被重试）直接报明确错误，不进 concat（避免 native 层异常/闪退）
            if (inputs == null || inputs.isEmpty()) {
                throw new java.io.IOException("分集数=0，无法合并。若为重试旧任务：其分集列表未持久化，请删除该任务后重新下载");
            }
            // 探测各集视频编码（majority 判定 → avc3/hev1）与可读性（等价后端 buildPlan 的 majorityKey）
            int hevc = 0, h264 = 0, bad = 0;
            for (int i = 0; i < inputs.size(); i++) {
                if (task.canceled) return;
                stage = "检测第" + (i + 1) + "集编码";
                MediaExtractor ex = new MediaExtractor();
                try {
                    ex.setDataSource(inputs.get(i).getAbsolutePath());
                    String vmime = null;
                    for (int t = 0; t < ex.getTrackCount(); t++) {
                        String mime = ex.getTrackFormat(t).getString(MediaFormat.KEY_MIME);
                        if (mime != null && mime.startsWith("video/")) { vmime = mime; break; }
                    }
                    if (vmime == null) { bad++; debug.append("第").append(i + 1).append("集: 无视频轨道\n"); }
                    else {
                        if (vmime.startsWith("video/hevc")) hevc++;
                        else if (vmime.startsWith("video/avc")) h264++;
                        debug.append("第").append(i + 1).append("集: 视频mime=").append(vmime).append('\n');
                    }
                } catch (Exception e) {
                    // CENC 密文文件部分设备 MediaExtractor 读不了 → 容错（C 层规范化会逐个复检并解密），
                    // 不中断合并；tag 判定由 C 层 majority 兜底
                    debug.append("第").append(i + 1).append("集探测失败(容错，C层将解密复检): ").append(e.getMessage()).append('\n');
                } finally { try { ex.release(); } catch (Exception ignored) {} }
            }
            if (bad > 0) throw new java.io.IOException("有 " + bad + " 集无视频轨道");

            // ffmpeg concat（自写 NDK JNI，直调 C API）：与后端 server/downloader.js 合并命令 1:1
            // （下载密文 → C 层 ffmpeg -decryption_key 原生解密重封装 → concat：
            //   -f concat -safe 0 -c copy + -video_track_timescale + -movflags +faststart
            //   + -tag:v avc1/hvc1 参数集只放 avcC：Android 解码器按四码匹配 stsd，
            //   写成 avc3/hev1（参数集 in-band）时部分机型直接判不支持 → 打开黑屏）
            String tag = h264 >= hevc ? "avc1" : "hvc1";   // majority 编码（红果短剧一般为 HEVC → hvc1）
            // 合并引擎：libffconcat（FFmpeg concat）优先，失败才回退系统 MediaMuxer。
            //
            // ⚠️ v0.18.76 及以前这里是反的（muxer 优先），正是「合集开始播放就卡、整段发顿」的来源。
            // 原因不是容器，是**帧的呈现时间被毁掉了**：
            //   MediaMuxer 要求 writeSampleData 的时间戳在写入序（= 解码序）上单调递增，而 H.264 有 B 帧，
            //   解码序里 PTS 必然回退（I P B B：0, 4, 1, 2）。代码只能把回退的时间戳「抬到上一个 +1µs」
            //   做单调化——44.5% 的回退帧被这么处理，实测该剧 3300 个样本里 66.9% 的时间戳被改写：
            //   3 帧被压成同一时刻（间隔 1µs），接着一个 133ms 的长停顿，如此循环。
            //   播放器于是按「解码序」出画：开局先抖一下，之后每一拍都在顿。
            //   而 MP4 想正确表达 B 帧必须写 ctts（合成偏移），MediaMuxer 只能从我们给的时间戳反推，
            //   MediaExtractor 又不暴露 DTS，纯 Java 这条路补不回来。
            // FFmpeg concat 是 -c copy 级别的重封装，直接保留源 stts/ctts，B 帧关系完整（实测合并后
            // 4309 处 B 帧倒序全部保留、零解码错误、时长与三集之和一致）。
            //
            // 这也解释了「公开模式合集流畅、私密模式合集卡顿」：公开模式（红果）的分集是 CENC 密文，
            // MediaExtractor 读不了 → muxer 直接失败 → 自动落到 native；私密模式（黄果）的分集已是
            // 明文 mp4，muxer 能读 → 于是正好走了那条会毁 B 帧的路。
            File nativeLog = new File(context.getFilesDir(), "native.log");
            // 合并引擎：FFmpeg concat（修之前 v0.18.71+ 一直用的 C 层 direct concat 引擎，时间轴正确
            // —— concat demuxer 保留源 stts/ctts）。上轮试过"系统 MediaMuxer 优先"，实测卡顿/音画
            // 不同步：muxer 逐片写入必须按写入序单调化时间戳，交错时间轴被压平（C 层注释同款教训：
            // 两段式把 501 帧挤进 9.7s → 播放加速卡顿、seek 崩溃）。
            // 红果分集是 CENC 密文，先本地解密成明文再交给 concat（修之前直接 concat 密文，
            // 产物是未解密密文，大小完整但样本全是密文，任何播放器都播不了）。
            java.util.List<File> plainInputs = new java.util.ArrayList<>();
            java.util.List<String> plainKeys = new java.util.ArrayList<>();
            boolean ok = false;
            try {
                stage = "解密分集";
                debug.append("解密 CENC 分集 ").append(inputs.size()).append(" 集…\n");
                for (int i = 0; i < inputs.size(); i++) {
                    String k = keys.get(i);
                    byte[] kb = com.hongguotv.core.LocalRemux.INSTANCE.keyFromHex(k);
                    if (kb != null) {
                        File tmp = new File(output.getParentFile(), "dec_" + i + ".mp4");
                        com.hongguotv.core.LocalRemux.INSTANCE.decrypt(inputs.get(i), tmp, kb);
                        decryptTmp.add(tmp);
                        plainInputs.add(tmp);
                    } else {
                        plainInputs.add(inputs.get(i));   // 明文源（黄果已解密 mp4 / 无 key 源）
                    }
                    plainKeys.add("");
                }
                stage = "libffconcat 合并多集";
                debug.append("libffconcat（FFmpeg concat）合并 ").append(plainInputs.size()).append(" 集…\n");
                if (output.exists()) output.delete();   // native 侧「存在即不覆盖」，残片会让它直接失败
                FFmpegConcat.concat(plainInputs, plainKeys, output, tag, debug, nativeLog);
                stage = "校验产物";
                FFmpegConcat.verify(output, plainInputs, debug);
                if (checkPicture(output, debug) == 2)
                    throw new java.io.IOException("产物抽帧全是纯色/全黑（打开会黑屏）");
                ok = true;
            } catch (Throwable e1) {
                debug.append("libffconcat 合并失败：").append(e1.getMessage()).append('\n');
                if (output.exists()) output.delete();
                try {
                    stage = "兜底系统 muxer 合并";
                    debug.append("兜底系统 MediaMuxer 合并（时间轴可能被压平）").append(plainInputs.size()).append(" 集…\n");
                    concatTsByMuxer(plainInputs.toArray(new File[0]), output, debug);
                    stage = "兜底产物校验";
                    FFmpegConcat.verify(output, plainInputs, debug);
                    if (checkPicture(output, debug) == 2)
                        throw new java.io.IOException("兜底合并后抽帧仍是纯色/全黑（打开会黑屏）");
                    ok = true;
                } catch (Throwable e2) {
                    debug.append("兜底合并也失败：").append(e2.getMessage()).append('\n');
                    if (output.exists()) output.delete();
                }
            }
            if (!ok) throw new java.io.IOException("两种合并引擎均失败（详见合并日志）");
            stage = "完成";
            debug.append("完成: 产物=").append(output.length() / 1048576).append("MB 引擎=")
                    .append(ok ? "libffconcat(tag=" + tag + ")" : "系统 muxer（B 帧时间戳可能被压平）").append('\n');
            task.debug = debug.toString();
        } catch (Exception e) {
            debug.append("失败阶段: ").append(stage).append('\n');
            debug.append("异常: ").append(e.getClass().getSimpleName()).append(": ").append(e.getMessage()).append('\n');
            task.debug = debug.toString();
            throw e;
        } finally {
            for (File tmp : decryptTmp) try { tmp.delete(); } catch (Exception ignored) {}
        }
    }

    /** 把产物视频轨 sample entry 标签 avc1→avc3、hvc1→hev1（in-band 参数集，等价后端 concat 的 -tag:v avc3/hev1）。
     *  MediaMuxer 强制要求 csd 且默认写 avc1/hvc1，但样本数据仍保留源（avc3/hev1）内联的 SPS/PPS/VPS，
     *  改标签后播放器即按帧内参数集解码：seek 到任何集都用该集自己的参数集，杜绝快进花屏/乱码。
     *  只改 stsd 内的 4 字节标签；moov 在文件末尾（MediaMuxer 无 faststart），读尾部定位足够。 */
    private static void patchInbandTag(File file) throws Exception {
        java.io.RandomAccessFile raf = new java.io.RandomAccessFile(file, "rw");
        try {
            long len = raf.length();
            long tailSize = Math.min(len, 8L << 20);   // 尾部 8MB（12 集 moov 约 1-2MB）
            long start = len - tailSize;
            byte[] tail = new byte[(int) tailSize];
            raf.seek(start);
            raf.readFully(tail);
            boolean changed = false;
            for (int i = 0; i + 4 <= tail.length; i++) {
                if (tail[i] == 'a' && tail[i + 1] == 'v' && tail[i + 2] == 'c' && tail[i + 3] == '1') {
                    tail[i + 3] = '3'; changed = true;                 // avc1 → avc3
                } else if (tail[i] == 'h' && tail[i + 1] == 'v' && tail[i + 2] == 'c' && tail[i + 3] == '1') {
                    tail[i + 1] = 'e'; tail[i + 2] = 'v'; changed = true;   // hvc1 → hev1
                }
            }
            if (changed) { raf.seek(start); raf.write(tail); }
        } finally { raf.close(); }
    }

    /** 若 format 缺 csd（avc3/hev1 内联参数集场景），从首个关键帧样本提取 SPS/PPS（HEVC 另含 VPS）注入 csd-0。
     *  返回 true=已有 csd 或注入成功；false=未注入（缺 csd 且提取失败）。 */
    private static boolean ensureCodecSpecificData(MediaFormat format, List<Sample> samples, String mime) {
        try {
            if (format == null || samples == null || samples.isEmpty()) return false;
            if (format.containsKey("csd-0")) return true;   // moov 自带 avcC（avc1 等），无需注入
            boolean hevc = mime != null && mime.startsWith("video/hevc");
            int[] want = hevc ? new int[]{32, 33, 34} : new int[]{7, 8};   // hevc: VPS/SPS/PPS；h264: SPS/PPS
            for (Sample s : samples) {
                if ((s.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) == 0) continue;
                List<byte[]> nal = extractParameterSets(s.data, hevc);
                if (nal.isEmpty()) continue;
                int total = 0;
                for (byte[] n : nal) total += n.length;
                ByteBuffer csd = ByteBuffer.allocate(total);
                for (byte[] n : nal) csd.put(n);
                csd.position(0);
                format.setByteBuffer("csd-0", csd);
                return true;
            }
            return false;   // 缺 csd 且关键帧内未提取到参数集
        } catch (Exception ignored) {
            // 提取失败不阻断合并（可能仍有其它设备可写），保留原 format
            return false;
        }
    }

    /** 扫描样本字节，按 H.264/HEVC 的 NAL 起始码切分，返回按序的 SPS/PPS（HEVC 含 VPS），数据不含起始码。
     *  兼容两种样本布局：AnnexB（00 00 01 起始码）与 AVCC length-prefixed（4 字节大端长度）。 */
    private static List<byte[]> extractParameterSets(ByteBuffer sample, boolean hevc) {
        List<byte[]> out = new ArrayList<>();
        byte[] d = new byte[sample.remaining()];
        sample.duplicate().get(d);
        int n = d.length;
        if (n < 5) return out;
        int[] found = new int[]{0, 0, 0};   // [vps, sps, pps]
        boolean annexb = false;
        // 判断首 NAL 分隔方式：00 00 01 / 00 00 00 01 → AnnexB；否则尝试 AVCC 长度前缀
        int b0 = d[0] & 0xFF, b1 = d[1] & 0xFF, b2 = d[2] & 0xFF, b3 = d[3] & 0xFF;
        if (b0 == 0 && b1 == 0 && (b2 == 1 || (b2 == 0 && b3 == 1))) annexb = true;
        if (annexb) {
            int i = 0;
            while (i < n - 4) {
                int start = -1;
                if ((d[i] & 0xFF) == 0 && (d[i + 1] & 0xFF) == 0) {
                    if ((d[i + 2] & 0xFF) == 1) start = i + 3;
                    else if ((d[i + 2] & 0xFF) == 0 && (d[i + 3] & 0xFF) == 1) start = i + 4;
                }
                if (start < 0) { i++; continue; }
                int end = -1;
                for (int j = start; j < n - 3; j++) {
                    if ((d[j] & 0xFF) == 0 && (d[j + 1] & 0xFF) == 0) {
                        if ((d[j + 2] & 0xFF) == 1) { end = j; break; }
                        if ((d[j + 2] & 0xFF) == 0 && (d[j + 3] & 0xFF) == 1) { end = j; break; }
                    }
                }
                int nalEnd = end < 0 ? n : end;
                if (start < nalEnd) {
                    int type = hevc ? ((d[start] & 0xFF) >> 1) & 0x3F : (d[start] & 0xFF) & 0x1F;
                    int idx = hevc ? (type == 32 ? 0 : type == 33 ? 1 : type == 34 ? 2 : -1)
                                   : (type == 7 ? 1 : type == 8 ? 2 : -1);
                    if (idx >= 0 && found[idx] == 0) {
                        found[idx] = 1;
                        out.add(java.util.Arrays.copyOfRange(d, start, nalEnd));
                    }
                }
                if (end < 0) break;
                i = end;
            }
        } else {
            // AVCC length-prefixed：4 字节大端长度 + NAL 数据，循环跳过
            int i = 0;
            while (i + 4 <= n) {
                int len = ((d[i] & 0xFF) << 24) | ((d[i + 1] & 0xFF) << 16)
                        | ((d[i + 2] & 0xFF) << 8) | (d[i + 3] & 0xFF);
                if (len <= 0 || i + 4 + len > n) break;
                int start = i + 4;
                int nalEnd = start + len;
                int type = hevc ? ((d[start] & 0xFF) >> 1) & 0x3F : (d[start] & 0xFF) & 0x1F;
                int idx = hevc ? (type == 32 ? 0 : type == 33 ? 1 : type == 34 ? 2 : -1)
                               : (type == 7 ? 1 : type == 8 ? 2 : -1);
                if (idx >= 0 && found[idx] == 0) {
                    found[idx] = 1;
                    out.add(java.util.Arrays.copyOfRange(d, start, nalEnd));
                }
                i += 4 + len;
            }
        }
        return out;
    }

    // ---- 导出到公共 Download（MediaStore，API 29+；旧版回退 app 专属目录）----

    /** 合并成功后清理分集：删除 app 私有分集（ep*.mp4 / norm_*.mp4）与公共 Downloads 分集（第XX集.mp4），
     *  只保留合并产物。合并失败/未合并不动，保证可重试。 */
    /** MediaStore 的 RELATIVE_PATH 恒带尾部斜杠（Download/Veyra/x/），拿不带斜杠的字符串做 = 匹配
     *  永远查不到 —— 这正是「合并成功但第NN集.mp4 一直删不掉」的根因。两种写法都放进 IN 里查。 */
    private static String[] relCandidates(String rel) {
        String bare = rel.endsWith("/") ? rel.substring(0, rel.length() - 1) : rel;
        return new String[]{bare + "/", bare};
    }

    private static String relSelection() {
        return MediaStore.Downloads.RELATIVE_PATH + " IN (?,?)";
    }

    /** 分集文件判定：合并产物（剧名.mp4 / ep001.mp4 之外的临时分集）才删。
     *  注意要覆盖 MediaStore 去重改名后的「第01集_1793034343293.mp4」——否则这些变体既匹配不到
     *  分集规则、也匹配不到清理规则，会永久留在剧集目录里。 */
    private static boolean isEpisodeArtifact(String name) {
        if (name == null) return false;
        return name.matches("第\\d+集.*\\.mp4")
                || name.matches("ep\\d+\\.mp4")
                // 调试模式下导出的素材包，删任务时也要一起清掉，别留在剧集目录里
                || name.matches("第\\d+集_调试包\\.zip")
                || name.startsWith("norm_") || name.endsWith(".part");
    }

    /** 剧集目录里的分集：集号 → 文件。名字兼容「第01集.mp4」与「第01集_1793034343293.mp4」
     *  （MediaStore 去重给的尾巴），这样合并永远不会因为文件名被动过就找不到分集。 */
    private java.util.Map<Integer, File> episodeFilesIn(File dir) {
        java.util.Map<Integer, File> map = new java.util.HashMap<>();
        File[] kids = dir == null ? null : dir.listFiles();
        if (kids == null) return map;
        java.util.regex.Pattern p = java.util.regex.Pattern.compile("^第(\\d+)集.*\\.mp4$");
        for (File f : kids) {
            if (!f.isFile() || f.length() <= 0) continue;
            java.util.regex.Matcher m = p.matcher(f.getName());
            if (!m.matches()) continue;
            int no;
            try { no = Integer.parseInt(m.group(1)); } catch (Exception e) { continue; }
            File old = map.get(no);
            // 同一集出现两份（正式名 + 漂移名）时优先正式名（名字更短的那个）
            if (old == null || f.getName().length() < old.getName().length()) map.put(no, f);
        }
        return map;
    }

    /** 把「第01集_1793034343293.mp4」正名回「第01集.mp4」。
     *  ROM 的 MediaStore 在插入时撞到同名文件会把名字改掉，而分集文件名是合并找人的依据，
     *  一旦漂移就报「分集不完整」。合并前、启动清理时都过一遍。 */
    private void normalizeEpisodeNames(File dir) {
        try {
            File[] kids = dir == null ? null : dir.listFiles();
            if (kids == null) return;
            java.util.regex.Pattern p = java.util.regex.Pattern.compile("^第(\\d+)集(?:[._\\-()\\s]+\\d{1,})\\S*\\.mp4$");
            String rel = Environment.DIRECTORY_DOWNLOADS + "/Veyra/" + dir.getName();
            for (File f : kids) {
                if (!f.isFile()) continue;
                java.util.regex.Matcher m = p.matcher(f.getName());
                if (!m.matches()) continue;
                String clean = "第" + m.group(1) + "集.mp4";
                File target = new File(dir, clean);
                if (target.exists() && target.length() > 0) {
                    // 正式名和时间戳名并存：留「新写入」的那份当正式名（时间戳名通常是刚下载的新内容，
                    // 正式名可能是上一批的旧文件，按 mtime 判新），旧的让位/删除，绝不静默删新留旧。
                    if (f.lastModified() > target.lastModified()) {
                        if (!target.delete()) {
                            // 删除失败（占用/只读）：先把旧正式名改名让位，时间戳名随后正名回正式名
                            target.renameTo(new File(dir, clean + "." + System.currentTimeMillis() + ".old"));
                        }
                    } else {
                        f.delete();
                        deletePublicFile(rel, f.getName());
                        continue;
                    }
                }
                // 正名（MediaStore rename → 文件系统 rename），失败重试 5 次 × 300ms：
                // 系统扫描刚写完的大文件可能短暂占用，rename 一次失败被吞 → 时间戳残留（用户实测）。
                boolean ok = false;
                for (int retry = 0; retry < 5 && !ok; retry++) {
                    if (retry > 0) try { Thread.sleep(300); } catch (InterruptedException ignored) { }
                    if (Build.VERSION.SDK_INT >= 29 && renamePublicEntry(rel, f.getName(), clean)) { ok = true; break; }
                    if (f.renameTo(target)) {
                        deletePublicFile(rel, f.getName());
                        MediaScannerConnection.scanFile(context, new String[]{target.getAbsolutePath()},
                                new String[]{"video/mp4"}, null);
                        ok = true;
                    }
                }
                if (!ok) {
                    try (java.io.FileWriter fw = new java.io.FileWriter(new File(context.getFilesDir(), "native.log"), true)) {
                        fw.append("正名失败（5 次仍失败）: ").append(f.getAbsolutePath()).append('\n');
                    } catch (Exception ignored) { }
                }
            }
        } catch (Exception ignored) { }
    }

    private void deleteEpisodesAfterMerge(Task t, String subDir) {
        try {
            File dir = dlDir(t.id);
            if (dir.exists()) {
                File[] kids = dir.listFiles();
                if (kids != null) for (File f : kids) {
                    String n = f.getName();
                    if (f.isFile() && (n.startsWith("ep") || n.startsWith("norm_"))) f.delete();
                }
            }
            // 剧集目录里的分集也清理（ep001.mp4 = 第 1 集的中间产物，整理后正名才是「剧名.mp4」）
            File edir = episodeDir(t.title);
            if (edir.exists() && !edir.equals(dir)) {
                File[] kids = edir.listFiles();
                if (kids != null) for (File f : kids) {
                    if (f.isFile() && isEpisodeArtifact(f.getName())) f.delete();
                }
            }
            if (Build.VERSION.SDK_INT >= 29) {
                String rel = Environment.DIRECTORY_DOWNLOADS + "/Veyra"
                        + (subDir == null || subDir.isEmpty() ? "" : "/" + subDir);
                try (android.database.Cursor c = context.getContentResolver().query(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        new String[]{MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME},
                        relSelection(), relCandidates(rel), null)) {
                    if (c != null) {
                        while (c.moveToNext()) {
                            String name = c.getString(1);
                            if (!isEpisodeArtifact(name)) continue;
                            // 保留本次合并成功的产物（单集任务时剧名可能与分集同名，不能误删）
                            if (name != null && t.title != null
                                    && name.equals(t.title.replaceAll("[\\\\/:*?\"<>|]", "_") + ".mp4")) continue;
                            try {
                                context.getContentResolver().delete(
                                        ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0)),
                                        null, null);
                            } catch (Exception ignored) { }
                        }
                    }
                } catch (Exception ignored) { }
            } else {
                File pub = new File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Veyra/" + subDir);
                File[] kids = pub.listFiles();
                if (kids != null) for (File f : kids) {
                    if (f.isFile() && isEpisodeArtifact(f.getName())) f.delete();
                }
            }
            // 任务目录（Download/Veyra/dl_xxx）在合并成功后已经没有价值：
            // 清掉 ts/playlist/key/日志，空了就删目录，避免文件管理器里留下一排 0 项的 dl_ 文件夹。
            cleanupTaskDir(t.id);
        } catch (Exception ignored) { }
    }

    /** 清理任务工作目录：删掉全部临时文件/子目录，目录空了再删掉目录本身。
     *  只在「合并成功」后调用 —— 合并失败必须保留 ts 分片供重试复用。 */
    private void cleanupTaskDir(String id) {
        try {
            File dir = dlDir(id);
            if (!dir.exists()) return;
            File[] kids = dir.listFiles();
            if (kids != null) for (File f : kids) {
                if (f.isFile()) f.delete();
                else deleteRecursively(f);
            }
            File[] left = dir.listFiles();
            if (left == null || left.length == 0) dir.delete();
        } catch (Exception ignored) { }
    }

    private Uri exportToDownloads(File file, String subDir, String displayName) throws Exception {
        return exportToDownloads(file, subDir, displayName, "video/mp4");
    }

    /** 上一次导出是否走的「直写文件系统」（false = 走了 MediaStore 回退，名字可能被系统改）。 */
    private volatile boolean lastExportDirect = false;

    /** 导出串行化：两个任务（同一部剧重复下载、或旧任务还没收尾）同时往同一个剧集目录写
     *  同名文件时，后写的那个必然撞名被 MediaStore 改成「第03集_<毫秒>.mp4」——
     *  「总是最后一集被改名」很可能就是这种并发撞出来的。加锁最省事。 */
    private static final Object EXPORT_LOCK = new Object();

    private Uri exportToDownloads(File file, String subDir, String displayName, String mime) throws Exception {
        synchronized (EXPORT_LOCK) {
            return exportToDownloadsInner(file, subDir, displayName, mime);
        }
    }

    private Uri exportToDownloadsInner(File file, String subDir, String displayName, String mime) throws Exception {
        lastExportDirect = false;
        String rel = Environment.DIRECTORY_DOWNLOADS + "/Veyra";
        if (subDir != null && !subDir.isEmpty()) rel += "/" + subDir;
        // ① 直接写文件系统 —— 主路径。
        //    只有这条路能保证文件名一个字符都不变。MediaStore 的 insert 在撞名时会把名字改成
        //    「剧名_<13位毫秒>.mp4」，而且改完还会再撞（0.18.80 实测：三集里总有一两集被打上后缀，
        //    合并随即报「分集不完整」）。既然是自家 App 往自家目录写，直接用 File 写最省事。
        //    本机验证过 App 对 Download/Veyra/** 有直接的读写权限（dl_ 临时目录就是这么建的）。
        cleanExportTarget(rel, displayName);   // 先清掉旧行与旧文件（含漂移名），避免扫描后出现两条
        File target = publicFile(subDir, displayName);
        if (writeDirect(file, target, mime)) { lastExportDirect = true; return Uri.fromFile(target); }
        // ② 直接写不可用（Android 11+ 无 MANAGE_EXTERNAL_STORAGE 的机型）→ 回退 MediaStore 插入。
        if (Build.VERSION.SDK_INT >= 29) {
            // 名字兜底策略：**用临时名插入**（唯一后缀，insert 阶段永远不会撞名 → 不会被打上
            // 「_<毫秒>.mp4」），内容写完再改名为正式名（改名阶段若撞名，cleanExportTarget 已
            // 先清旧正式名并等待盘上消失）；插完读回 DISPLAY_NAME 校验，对不上再 rename/盘上 rename。
            for (int attempt = 0; attempt < 3; attempt++) {
                cleanExportTarget(rel, displayName);
                String pendName = displayName + "." + Long.toHexString(System.nanoTime()) + ".pend";
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, pendName);
                values.put(MediaStore.Downloads.MIME_TYPE, mime);
                values.put(MediaStore.Downloads.RELATIVE_PATH, rel);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) break;
                try (OutputStream os = context.getContentResolver().openOutputStream(uri);
                     InputStream is = new FileInputStream(file)) {
                    if (os == null) throw new java.io.IOException("无法写入系统下载目录");
                    byte[] buffer = new byte[256 * 1024];
                    int n;
                    while ((n = is.read(buffer)) > 0) os.write(buffer, 0, n);
                } catch (Exception we) {
                    try { context.getContentResolver().delete(uri, null, null); } catch (Exception ignored) { }
                    throw we;
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.Downloads.IS_PENDING, 0);
                context.getContentResolver().update(uri, done, null, null);
                // 改名正式名：先确保旧正式名（含漂移变体）已清并等盘上消失，再 update DISPLAY_NAME
                cleanExportTarget(rel, displayName);
                ContentValues rn = new ContentValues();
                rn.put(MediaStore.Downloads.DISPLAY_NAME, displayName);
                context.getContentResolver().update(uri, rn, null, null);
                String actual = queryDisplayName(uri);
                if (displayName.equals(actual)) return uri;
                // 名字仍不对（ROM 去重逻辑把 update 也改写）：先原地改名回原名
                if (renameEntry(uri, displayName)) return uri;
                // MediaStore 的 update 也会被去重逻辑再次改写，最后一招是在文件系统上直接改名
                //（rename 不会被自动加后缀），改完删旧条目 + 扫一次新文件让库和盘一致。
                if (forceRenameOnDisk(uri, rel, displayName)) return uri;
                // 都失败：删掉这次的结果，等物理删除落地后重来
                try { context.getContentResolver().delete(uri, null, null); } catch (Exception ignored) { }
                try { Thread.sleep(120); } catch (InterruptedException ignored) { }
            }
        }
        // ③ 公共目录完全写不了 → 回退 app 专属 Download 目录（至少文件还在，App 内可播）
        File dir = new File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Veyra");
        if (subDir != null && !subDir.isEmpty()) dir = new File(dir, subDir);
        if (!dir.exists()) dir.mkdirs();
        File fallback = new File(dir, displayName);
        copyFile(file, fallback);
        MediaScannerConnection.scanFile(context, new String[]{fallback.getAbsolutePath()}, new String[]{mime}, null);
        return Uri.fromFile(fallback);
    }

    /** Download/Veyra/<subDir>/<name>（只拼路径）。 */
    @SuppressWarnings("deprecation")
    private static File publicFile(String subDir, String name) {
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Veyra");
        if (subDir != null && !subDir.isEmpty()) dir = new File(dir, subDir);
        return new File(dir, name);
    }

    /** 直接把内容写到公共 Downloads 目录（不经 MediaStore 的命名逻辑）：
     *  先写 <name>.part → 确保目标名真的没人占 → rename 成正名 → 扫描入库。
     *  rename 不会被任何系统逻辑加后缀，所以只要这一步成功，文件名就一定是我们要的。 */
    private boolean writeDirect(File src, File target, String mime) {
        File tmp = null;
        try {
            File dir = target.getParentFile();
            if (dir == null) return false;
            if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory()) return false;
            tmp = new File(dir, target.getName() + "." + Long.toHexString(System.nanoTime()) + ".part");
            try (InputStream in = new FileInputStream(src);
                 OutputStream out = new FileOutputStream(tmp)) {
                byte[] buffer = new byte[256 * 1024];
                int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            }
            // 目标必须**真的**不存在才 rename：MediaStore 的删除是异步的（行删了、文件还在），
            // 只删一次就 rename 会在部分 ROM 上失败/被改名，所以这里轮询等它彻底消失。
            if (!ensureGone(target)) { tmp.delete(); return false; }
            if (!tmp.renameTo(target)) { tmp.delete(); return false; }
            tmp = null;
            MediaScannerConnection.scanFile(context, new String[]{target.getAbsolutePath()},
                    new String[]{mime}, null);
            return true;
        } catch (Exception e) {
            if (tmp != null) { try { tmp.delete(); } catch (Exception ignored) { } }
            return false;
        }
    }

    /** 反复尝试删除，直到文件真的不在（最多约 2s）。异步删除的落地时间不定，只能等。 */
    private static boolean ensureGone(File f) {
        if (!f.exists()) return true;
        for (int i = 0; i < 16; i++) {
            f.delete();
            if (!f.exists()) return true;
            try { Thread.sleep(120); } catch (InterruptedException ignored) { }
        }
        return !f.exists();
    }

    /** 导出前清空剧集目录里的旧分集（含「第03集_1793036388994.mp4」这种漂移名与 .part 残片）。
     *  只要盘上还留着同名文件，写新文件时就会被 MediaStore 撞名改名 —— 这是反复出现后缀的源头。 */
    private void purgeEpisodeArtifacts(String subDir) {
        try {
            String rel = Environment.DIRECTORY_DOWNLOADS + "/Veyra" + (subDir == null || subDir.isEmpty() ? "" : "/" + subDir);
            if (Build.VERSION.SDK_INT >= 29) {
                try (android.database.Cursor c = context.getContentResolver().query(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        new String[]{MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME},
                        relSelection(), relCandidates(rel), null)) {
                    if (c != null) {
                        while (c.moveToNext()) {
                            String name = c.getString(1);
                            // 调试包是素材，别顺手删了
                            if (name == null || name.contains("调试包") || !isEpisodeArtifact(name)) continue;
                            try {
                                context.getContentResolver().delete(ContentUris.withAppendedId(
                                        MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0)), null, null);
                            } catch (Exception ignored) { }
                        }
                    }
                } catch (Exception ignored) { }
            }
            File dir = publicFile(subDir, "x").getParentFile();
            if (dir == null) return;
            // 删 + 等：MediaStore 的删除是异步的，删完不落地等于没删
            for (int round = 0; round < 16; round++) {
                File[] kids = dir.listFiles();
                boolean any = false;
                if (kids != null) for (File f : kids) {
                    if (!f.isFile() || f.getName().contains("调试包") || !isEpisodeArtifact(f.getName())) continue;
                    f.delete();
                    any = true;
                }
                if (!any) return;
                try { Thread.sleep(120); } catch (InterruptedException ignored) { }
            }
        } catch (Exception ignored) { }
    }

    /** 导出前清场：删掉同名条目 + 已经漂移成「名字_<13位毫秒>.mp4」的历史残留。
     *  连实体文件一起删：MediaStore 的删除是异步的，只删行不删文件时下一次插入还会被改名。 */
    private void cleanExportTarget(String rel, String displayName) {
        try {
            final java.util.regex.Pattern drift = driftPattern(displayName);
            String dir = publicPathOf(rel);
            try (android.database.Cursor c = context.getContentResolver().query(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME},
                    relSelection(), relCandidates(rel), null)) {
                if (c != null) {
                    while (c.moveToNext()) {
                        String name = c.getString(1);
                        if (name == null) continue;
                        boolean hit = name.equals(displayName) || drift.matcher(name).matches();
                        if (!hit) continue;
                        try {
                            context.getContentResolver().delete(ContentUris.withAppendedId(
                                    MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0)), null, null);
                        } catch (Exception ignored) { }
                        if (dir != null) {
                            File df = new File(dir, name);
                            try { df.delete(); } catch (Exception ignored) { }
                            // MediaStore 行删除是异步的：行删了、底层文件可能还被扫描器挂一会儿。
                            // 不等它真正消失就写同名文件 → 扫描器撞名 →「第NN集_<毫秒>.mp4」（时间戳根因）。
                            // 这里轮询直到盘上确实没了（最多 3s），写新文件时目录里才是干净的。
                            for (int w = 0; w < 15 && df.exists(); w++) {
                                try { Thread.sleep(200); } catch (InterruptedException ie) { break; }
                                try { df.delete(); } catch (Exception ignored) { }
                            }
                        }
                    }
                }
            } catch (Exception ignored) { }
        } catch (Exception ignored) { }
    }

    /** 「剧名.mp4」→ 匹配「剧名_1793032838265.mp4」这种被 MediaStore 去重改名的变体。 */
    private static java.util.regex.Pattern driftPattern(String displayName) {
        int dot = displayName.lastIndexOf('.');
        String base = dot > 0 ? displayName.substring(0, dot) : displayName;
        String ext = dot > 0 ? displayName.substring(dot) : "";
        return java.util.regex.Pattern.compile(
                java.util.regex.Pattern.quote(base) + "_\\d{10,}" + java.util.regex.Pattern.quote(ext));
    }

    /** Download/Veyra/<剧名>/<文件名> 的绝对路径（只拼路径，不建目录）：
     *  用于确认 MediaStore 导出的分集真能用 File 读到，以及合并时直接读它。 */
    private static File publicEpisodeFile(String title, String name) {
        String sub = (title == null || title.isEmpty()) ? "download" : title.replaceAll("[\\\\/:*?\"<>|]", "_");
        return publicFile(sub, name);
    }

    /** "Download/Veyra/剧名" → 绝对路径；用于在 MediaStore 之外补一刀实体文件删除。 */
    private static String publicPathOf(String rel) {
        try {
            File root = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            String tail = rel;
            if (tail.startsWith(Environment.DIRECTORY_DOWNLOADS))
                tail = tail.substring(Environment.DIRECTORY_DOWNLOADS.length());
            while (tail.startsWith("/")) tail = tail.substring(1);
            return new File(root, tail).getAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }

    private String queryDisplayName(Uri uri) {
        try (android.database.Cursor c = context.getContentResolver().query(
                uri, new String[]{MediaStore.Downloads.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) { }
        return null;
    }

    /** 原地改名（MediaStore 会连实体文件一起 rename），成功后读回校验。 */
    private boolean renameEntry(Uri uri, String name) {
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, name);
            context.getContentResolver().update(uri, v, null, null);
            return name.equals(queryDisplayName(uri));
        } catch (Exception e) {
            return false;
        }
    }

    /** 按「目录 + 旧名」找行并改名（sweep 修历史漂移用）。 */
    private boolean renamePublicEntry(String rel, String from, String to) {
        try {
            String[] rels = relCandidates(rel);
            try (android.database.Cursor c = context.getContentResolver().query(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Downloads._ID},
                    relSelection() + " AND " + MediaStore.Downloads.DISPLAY_NAME + "=?",
                    new String[]{rels[0], rels[1], from}, null)) {
                if (c != null && c.moveToNext()) {
                    return renameEntry(ContentUris.withAppendedId(
                            MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0)), to);
                }
            }
        } catch (Exception ignored) { }
        return false;
    }

    /** 直接在文件系统上改名（不受 MediaStore 的去重改名逻辑影响）。
     *  顺序很重要：先 rename 实体文件，再删旧条目，最后扫新文件——反过来会让 provider 把文件一起删掉。 */
    private boolean forceRenameOnDisk(Uri uri, String rel, String displayName) {
        try {
            if (Build.VERSION.SDK_INT < 29) return false;
            String path = null;
            try (android.database.Cursor c = context.getContentResolver().query(
                    uri, new String[]{MediaStore.Downloads.DATA}, null, null, null)) {
                if (c != null && c.moveToFirst()) path = c.getString(0);
            }
            String actual = queryDisplayName(uri);
            if (path == null || actual == null) {
                String dir = publicPathOf(rel);
                if (dir == null || actual == null) return false;
                path = new File(dir, actual).getAbsolutePath();
            }
            File from = new File(path);
            if (!from.exists()) return false;
            File to = new File(from.getParentFile(), displayName);
            if (to.exists()) to.delete();
            if (!from.renameTo(to)) return false;
            try { context.getContentResolver().delete(uri, null, null); } catch (Exception ignored) { }
            MediaScannerConnection.scanFile(context, new String[]{to.getAbsolutePath()},
                    new String[]{"video/mp4"}, null);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static void copyFile(File src, File dst) throws Exception {
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
            byte[] buffer = new byte[256 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
        }
    }

    /** 删除公共 Downloads/Veyra/<剧名>/ 下该剧全部 mp4 产物与残留：
     *  原名（<剧名>.mp4）+ MediaStore 同名冲突自动加后缀的孤儿（<剧名>_<时间戳>.mp4）+ 空文件夹。
     *  与 task.output 指向的 uri/文件互补，确保「APP 删除 = 手机存储彻底删干净」。 */
    private void purgePublicExports(Task t) {
        try {
            String base = t.title == null ? "" : t.title.replaceAll("[\\\\/:*?\"<>|]", "_");
            // 用户要求：点删除 = 直接删掉 Download/Veyra/<剧名>/ 整个剧集文件夹，
            // 一次清干净分集、合并产物、以及 MediaStore 撞名产生的「第NN集_<时间戳>.mp4」残留。
            if (Build.VERSION.SDK_INT >= 29) {
                String rel = Environment.DIRECTORY_DOWNLOADS + "/Veyra" + (base.isEmpty() ? "" : "/" + base);
                // ① MediaStore 删除：Downloads 集合 + Files 全库（部分 ROM 索引放在 Files 集合）按目录前缀删全部行。
                //    先删行让扫描器放弃文件，底层删除是异步的 —— 删完必须等它落地再动盘，否则文件被占用删不掉。
                for (int round = 0; round < 2; round++) {
                    try {
                        context.getContentResolver().delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                                MediaStore.Downloads.RELATIVE_PATH + " LIKE ?", new String[]{rel + "%"});
                    } catch (Exception ignored) { }
                    try {
                        context.getContentResolver().delete(MediaStore.Files.getContentUri("external"),
                                MediaStore.Files.FileColumns.RELATIVE_PATH + " LIKE ?", new String[]{rel + "%"});
                    } catch (Exception ignored) { }
                    try { Thread.sleep(800); } catch (InterruptedException ignored) { }
                }
                // ② 文件系统：递归删除整个剧集文件夹（文件 + 目录）。
                //    扫描器/系统进程可能短暂占用文件，重试 20 轮 × 500ms（最长 10s）；
                //    仍删不掉就把目录路径写进 native.log（记录现场，下次删除再收尾），绝不静默。
                File pub = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Veyra/" + base);
                File pubLog = new File(context.getFilesDir(), "native.log");
                boolean gone = !pub.exists();
                for (int attempt = 0; attempt < 20 && !gone; attempt++) {
                    if (attempt > 0) try { Thread.sleep(500); } catch (InterruptedException ie) { break; }
                    if (pub.exists()) deleteRecursive(pub);
                    gone = !pub.exists();
                }
                if (!gone) {
                    try (java.io.FileWriter fw = new java.io.FileWriter(pubLog, true)) {
                        fw.append("删除残留目录（20 轮仍删不掉）: ").append(pub.getAbsolutePath()).append('\n');
                        String[] left = pub.list();
                        if (left != null) fw.append("  残留: ").append(String.join(";", left)).append('\n');
                    } catch (Exception ignored) { }
                }
            } else {
                File dir = new File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Veyra/" + base);
                if (dir.exists() && dir.isDirectory()) deleteRecursive(dir);
            }
        } catch (Exception ignored) { }
    }

    private static void deleteRecursive(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) { File[] children = file.listFiles(); if (children != null) for (File c : children) deleteRecursive(c); }
        file.delete();
    }

    private static byte[] hexDecode(String s) {
        byte[] data = new byte[s.length() / 2];
        for (int i = 0; i < data.length; i++) data[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return data;
    }

    /** 音频转码管线：LATM(HE-AAC) → AAC-LC（与后端 server/downloader.js 的 juku 方案一致）。
     *  红果分集音频为 audio/mp4a-latm（HE-AAC，含 SBR/PS），MediaMuxer 直写 LATM 后系统播放器
     *  在快进/seek 时因采样率/声道动态切换而声音乱码；统一转成 AAC-LC（aac_low/192k）后 seek 稳定。
     *  流程：MediaCodec 解码器 → PCM → MediaCodec AAC 编码器 → 直接写 MediaMuxer（不落盘）。
     *  每集一个实例（各集 srcFormat 独立），轨道 csd 由第 1 集 pumpConfig() 产出并在 addTrack 前注入。 */
    private static final class AudioTranscoder {
        final MediaCodec dec, enc;
        final List<Sample> samples;
        final long[] lastRef;
        int si = 0;
        boolean decEos = false, encEos = false;
        final ByteBuffer[] decIn, decOut, encIn, encOut;
        final MediaCodec.BufferInfo decInfo = new MediaCodec.BufferInfo();
        final MediaCodec.BufferInfo encInfo = new MediaCodec.BufferInfo();
        final int srcSr, srcCh;

        AudioTranscoder(MediaFormat srcFmt, List<Sample> sampleList, long[] lastTRef) throws Exception {
            String mime = srcFmt.getString(MediaFormat.KEY_MIME);
            srcSr = srcFmt.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? srcFmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 48000;
            srcCh = srcFmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? srcFmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 2;
            dec = MediaCodec.createDecoderByType(mime);
            dec.configure(srcFmt, null, null, 0);
            dec.start();
            enc = MediaCodec.createEncoderByType("audio/mp4a-latm");
            MediaFormat e = MediaFormat.createAudioFormat("audio/mp4a-latm", srcSr, srcCh);
            e.setInteger(MediaFormat.KEY_BIT_RATE, 192000);
            e.setInteger("aac-profile", 2);            // AAC-LC（KEY_AAC_PROFILE 常量高 SDK 才有，用字面量）
            e.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 65536);
            enc.configure(e, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            enc.start();
            samples = sampleList;
            lastRef = lastTRef;
            decIn = dec.getInputBuffers(); decOut = dec.getOutputBuffers();
            encIn = enc.getInputBuffers(); encOut = enc.getOutputBuffers();
        }

        /** 泵送直到拿到编码器的 codec-config（含 csd-0），返回该 format（用于 addTrack）；失败返回 null。 */
        MediaFormat pumpConfig() throws Exception {
            int spin = 0;
            while (spin++ < 4000) {
                feedDecoder();
                if (pipeDecoderToEncoder()) {
                    int eOut = enc.dequeueOutputBuffer(encInfo, 0);
                    if (eOut >= 0) {
                        if ((encInfo.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                            MediaFormat f = enc.getOutputFormat();
                            enc.releaseOutputBuffer(eOut, false);
                            return f;
                        }
                        enc.releaseOutputBuffer(eOut, false);   // 数据帧暂不入 muxer，等轨道注册后再写（队列保留后续帧）
                    }
                }
                if (decEos && si >= samples.size()) break;
            }
            return null;
        }

        /** 泵完剩余全部音频帧，收集为已绝对化 PTS 的样本列表（供与视频交错写入，等价后端转码输出交错）。
         *  自动跳过 codec-config 帧；maxRel 为本集相对时长上限（相对 base）：超过直接丢弃（音频按视频时长截断，对齐后端 -t）。
         *  注意：返回列表的 Sample.pts 已是绝对写入时间（含 offset），归并写入时按 aBase=0/aOffset=0 处理。 */
        List<Sample> pumpAllCollect(long base, long offset, long maxRel) throws Exception {
            List<Sample> out = new ArrayList<>();
            int spin = 0;
            while (!encEos && spin++ < 2000000) {
                feedDecoder();
                pipeDecoderToEncoder();
                int eOut = enc.dequeueOutputBuffer(encInfo, 0);
                if (eOut < 0) continue;
                if ((encInfo.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) { enc.releaseOutputBuffer(eOut, false); continue; }
                long rel = encInfo.presentationTimeUs - base;
                if (maxRel >= 0 && rel > maxRel) { enc.releaseOutputBuffer(eOut, false); continue; }   // 截断
                long t = rel + offset;
                if (t < 0) t = 0;
                if (t <= lastRef[0]) t = lastRef[0] + 1;   // 跨集绝对单调（与 writeSamples 一致）
                lastRef[0] = t;
                ByteBuffer outBuf = encOut[eOut];
                outBuf.position(encInfo.offset);
                outBuf.limit(encInfo.offset + encInfo.size);
                ByteBuffer copy = ByteBuffer.allocate(encInfo.size);
                copy.put(outBuf);
                copy.flip();
                out.add(new Sample(t, encInfo.size, encInfo.flags, copy));
                enc.releaseOutputBuffer(eOut, false);
                if ((encInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) encEos = true;
            }
            if (!encEos && !out.isEmpty()) return out;   // 编码器 EOS 偶发丢失/延迟（解码端 EOS 帧被丢）：用已收集音频，避免整次合并失败
            if (!encEos) throw new java.io.IOException("音频转码未正常结束");
            return out;
        }

        private void feedDecoder() throws Exception {
            int inIdx = dec.dequeueInputBuffer(0);
            if (inIdx < 0) return;
            if (si < samples.size()) {
                Sample s = samples.get(si++);
                ByteBuffer b = decIn[inIdx];
                b.clear();
                if (s.size > b.capacity()) throw new java.io.IOException("音频样本超过解码器输入容量: " + s.size);
                s.data.duplicate().get(b.array(), 0, (int) s.size);
                dec.queueInputBuffer(inIdx, 0, (int) s.size, s.pts, (int) s.flags);
            } else if (!decEos) {
                decEos = true;
                dec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
            }
        }

        /** 解码器输出 → 编码器输入；返回是否有可继续取的编码器输出。 */
        private boolean pipeDecoderToEncoder() throws Exception {
            int outIdx = dec.dequeueOutputBuffer(decInfo, 0);
            if (outIdx < 0) return true;
            if ((decInfo.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) { dec.releaseOutputBuffer(outIdx, false); return true; }
            int eIn = enc.dequeueInputBuffer(0);
            if (eIn < 0) { dec.releaseOutputBuffer(outIdx, false); return true; }
            ByteBuffer src = decOut[outIdx];
            src.position(decInfo.offset);
            src.limit(decInfo.offset + decInfo.size);
            ByteBuffer dst = encIn[eIn];
            dst.clear();
            dst.put(src);
            enc.queueInputBuffer(eIn, 0, decInfo.size, decInfo.presentationTimeUs, decInfo.flags);
            dec.releaseOutputBuffer(outIdx, false);
            if ((decInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) decEos = true;
            return true;
        }

        void release() {
            try { enc.stop(); } catch (Exception ignored) {}
            try { dec.stop(); } catch (Exception ignored) {}
            try { enc.release(); } catch (Exception ignored) {}
            try { dec.release(); } catch (Exception ignored) {}
        }
    }
}
