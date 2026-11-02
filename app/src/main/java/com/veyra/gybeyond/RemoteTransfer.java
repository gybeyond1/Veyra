package com.veyra.gybeyond;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 「传到远程服务器」的后台任务：一个串行队列（局域网带宽就那么多，并发上传只会互相拖慢），
 * 每个任务 = 一部剧 → 远端同名文件夹 → 逐个文件上传。
 *
 * 与下载任务解耦：下载任务只管把文件落到本机，传输看的是「本机现在有什么文件」，
 * 所以下载完成后自动传、以及「我的下载 → 传输到远程服务器」手动补传，走的是同一条路。
 */
final class RemoteTransfer {
    private static final String TAG = "VeyraRemote";
    private static final int MAX_JOBS = 40;

    private static RemoteTransfer instance;

    static synchronized RemoteTransfer get(Context context) {
        if (instance == null) instance = new RemoteTransfer(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private final List<Job> jobs = Collections.synchronizedList(new ArrayList<>());

    private RemoteTransfer(Context context) {
        this.context = context;
        load();
    }

    static final class Job {
        final String id;
        final String taskId;
        final String remoteId;
        volatile String serverName = "";
        volatile String title = "";
        volatile String dirName = "";
        volatile String status = "queued";   // queued | running | done | failed | canceled
        volatile String detail = "";
        volatile String error = "";
        volatile int total = 0;
        volatile int done = 0;
        volatile long bytes = 0;
        volatile long totalBytes = 0;
        volatile long createdAt = System.currentTimeMillis();
        volatile boolean canceled = false;
        volatile JSONArray files = new JSONArray();

        Job(String id, String taskId, String remoteId) {
            this.id = id;
            this.taskId = taskId;
            this.remoteId = remoteId;
        }

        int percent() {
            if (totalBytes > 0) return (int) Math.max(0, Math.min(100, bytes * 100 / totalBytes));
            if (total > 0) return Math.max(0, Math.min(100, done * 100 / total));
            return 0;
        }

        JSONObject snapshot() {
            JSONObject out = new JSONObject();
            try {
                out.put("id", id).put("taskId", taskId).put("remoteId", remoteId)
                        .put("serverName", serverName).put("title", title).put("dirName", dirName)
                        .put("status", status).put("detail", detail).put("error", error)
                        .put("total", total).put("done", done)
                        .put("bytes", bytes).put("totalBytes", totalBytes).put("percent", percent())
                        .put("createdAt", createdAt).put("files", files);
            } catch (Exception ignored) { }
            return out;
        }
    }

    // ---- 对外 API ----

    /** 给某一集数下载任务排一次传输。重复点击/自动触发都安全：同任务同服务器在跑就直接复用。 */
    JSONObject enqueue(String taskId, String remoteId) throws Exception {
        if (taskId == null || taskId.isEmpty()) throw new IllegalArgumentException("下载任务不存在");
        JSONObject server = RemoteStore.find(context, remoteId);
        if (server == null) throw new IllegalStateException("远程服务器配置不存在，请到设置里重新添加");
        JSONObject payload = DownloadManager.get(context).transferPayload(taskId);

        synchronized (jobs) {
            for (int i = 0; i < jobs.size(); i++) {
                Job job = jobs.get(i);
                if (!job.taskId.equals(taskId) || !job.remoteId.equals(remoteId)) continue;
                if ("queued".equals(job.status) || "running".equals(job.status)) return job.snapshot();
                // 同一部剧同一个服务器只留最新一条记录，避免列表里堆一串历史
                jobs.remove(i);
                break;
            }
        }
        Job job = new Job(UUID.randomUUID().toString().replace("-", "").substring(0, 12), taskId, remoteId);
        job.serverName = server.optString("name", "");
        job.title = payload.optString("title", "");
        job.dirName = payload.optString("dirName", "");
        job.files = payload.optJSONArray("files");
        job.total = job.files == null ? 0 : job.files.length();
        job.totalBytes = payload.optLong("bytes", 0);
        job.detail = "排队中";
        jobs.add(0, job);
        trim();
        persist();
        final Job target = job;
        pool.execute(() -> run(target));
        return job.snapshot();
    }

    JSONArray list() {
        JSONArray out = new JSONArray();
        synchronized (jobs) { for (Job job : jobs) out.put(job.snapshot()); }
        return out;
    }

    void cancel(String id) {
        synchronized (jobs) {
            for (Job job : jobs) {
                if (!job.id.equals(id)) continue;
                if ("queued".equals(job.status) || "running".equals(job.status)) {
                    job.canceled = true;
                    job.status = "canceled";
                    job.detail = "已取消";
                    job.error = "已取消";
                    persist();
                }
            }
        }
    }

    /** 任务被删除/清空时把关联的传输记录一并清掉（「我的下载」里不会再出现幽灵状态）。 */
    void forgetTask(String taskId) {
        if (taskId == null || taskId.isEmpty()) return;
        boolean changed = false;
        synchronized (jobs) {
            for (int i = jobs.size() - 1; i >= 0; i--) {
                if (jobs.get(i).taskId.equals(taskId)) { jobs.remove(i); changed = true; }
            }
        }
        if (changed) persist();
    }

    // ---- 执行 ----

    private void run(Job job) {
        JSONObject server = RemoteStore.find(context, job.remoteId);
        if (server == null) {
            fail(job, "远程服务器配置已删除，请重新选择");
            return;
        }
        job.status = "running";
        job.detail = "连接服务器…";
        persist();
        RemoteClient client = null;
        try {
            client = RemoteClient.create(server);
            client.open();
            String dir = RemoteClient.sanitize(job.dirName.isEmpty() ? job.title : job.dirName, "download");
            client.ensureDir(dir);
            job.detail = "准备上传 " + job.total + " 个文件";
            persist();
            JSONArray files = job.files == null ? new JSONArray() : job.files;
            for (int i = 0; i < files.length(); i++) {
                if (job.canceled) return;
                JSONObject item = files.optJSONObject(i);
                if (item == null) continue;
                File file = new File(item.optString("path", ""));
                if (!file.exists() || file.length() == 0) {
                    job.done = i + 1;
                    continue;
                }
                job.detail = "上传 " + item.optString("name", "") + "（" + (i + 1) + "/" + files.length() + "）";
                persist();
                client.upload(file, dir, item.optString("name", file.getName()), delta -> { job.bytes += delta; });
                job.done = i + 1;
                persist();
            }
            if (job.canceled) return;
            job.status = "done";
            job.bytes = Math.max(job.bytes, job.totalBytes);
            job.detail = "已传到 " + job.serverName + " / " + dir;
            Log.i(TAG, "done " + job.title + " -> " + client.target());
        } catch (Exception error) {
            if (!job.canceled) fail(job, RemoteClient.describeError(error));
        } finally {
            if (client != null) {
                try { client.close(); } catch (Exception ignored) { }
            }
            persist();
        }
    }

    private void fail(Job job, String message) {
        job.status = "failed";
        job.error = message;
        job.detail = "传输失败";
        Log.w(TAG, "failed " + job.title + ": " + message);
        persist();
    }

    // ---- 持久化 ----

    private void trim() {
        while (jobs.size() > MAX_JOBS) jobs.remove(jobs.size() - 1);
    }

    private File storeFile() {
        return new File(context.getFilesDir(), "remote-jobs.json");
    }

    private void persist() {
        try {
            JSONArray arr = new JSONArray();
            synchronized (jobs) {
                for (Job job : jobs) arr.put(job.snapshot());
            }
            File tmp = new File(context.getFilesDir(), "remote-jobs.json.tmp");
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(tmp)) {
                out.write(arr.toString().getBytes("UTF-8"));
                out.getFD().sync();
            }
            java.nio.file.Files.move(tmp.toPath(), storeFile().toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception ignored) { }
    }

    private void load() {
        File file = storeFile();
        if (!file.exists()) return;
        try {
            String raw = new String(java.nio.file.Files.readAllBytes(file.toPath()), "UTF-8");
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item == null) continue;
                Job job = new Job(item.optString("id", ""), item.optString("taskId", ""), item.optString("remoteId", ""));
                job.serverName = item.optString("serverName", "");
                job.title = item.optString("title", "");
                job.dirName = item.optString("dirName", "");
                job.status = item.optString("status", "done");
                if ("running".equals(job.status) || "queued".equals(job.status)) {
                    job.status = "failed";
                    job.error = "已中断（应用重启）";
                    job.detail = "已中断";
                }
                job.detail = item.optString("detail", job.detail);
                job.error = item.optString("error", job.error);
                job.total = item.optInt("total", 0);
                job.done = item.optInt("done", 0);
                job.bytes = item.optLong("bytes", 0);
                job.totalBytes = item.optLong("totalBytes", 0);
                job.createdAt = item.optLong("createdAt", job.createdAt);
                JSONArray files = item.optJSONArray("files");
                if (files != null) job.files = files;
                jobs.add(job);
            }
        } catch (Exception ignored) { }
    }
}
