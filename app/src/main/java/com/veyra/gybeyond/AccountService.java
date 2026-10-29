package com.veyra.gybeyond;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * 账号与片单云同步（自建后端版）。
 *
 * 原实现依赖 Parse SDK / Back4App，本版改为调用 server/ 自建轻量后端
 * （Express，token 认证，scrypt 密码哈希）。接口契约与后端 server/README.md 一致。
 * 与旧版保持相同的方法签名，MainActivity / app.js 无需改动。
 */
final class AccountService {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private final Context context;
    private final AppStore store;
    private final OkHttpClient client;
    private String baseUrl;   // 后端地址：登录/注册时可改（存 ServerConfig，通用部署）

    /** 当前后端地址（NAS 成品流式播放拼文件 URL 用）；未登录返回空串。 */
    public String baseUrl() { return baseUrl == null ? "" : baseUrl; }

    /** 当前登录 token（NAS 成品流式播放带 Bearer 鉴权用）。 */
    public String authToken() { return prefs.getString("token", ""); }
    private final SharedPreferences prefs;
    private volatile long lastProfileRefresh;
    private final AtomicBoolean refreshingProfile = new AtomicBoolean();

    AccountService(Context context, AppStore store) {
        this.context = context.getApplicationContext();
        this.store = store;
        this.baseUrl = ServerConfig.get(context);
        this.client = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .build();
        this.prefs = context.getSharedPreferences("chengzi-auth", Context.MODE_PRIVATE);
    }

    boolean isLoggedIn() { return !prefs.getString("token", "").isEmpty(); }
    String userId() { return prefs.getString("userId", ""); }
    /** 当前角色（admin/user，本地缓存；进私密模式前请先 refreshProfileNow 拉最新）。 */
    String role() { return prefs.getString("role", "user"); }
    /** 私密模式是否已解锁（跟账号走，服务端记录，本地缓存）。 */
    boolean isPrivateUnlocked() { return prefs.getBoolean("huangguoUnlocked", false); }

    /** 强制从服务端刷新账号资料（角色/解锁状态），绕过 5 分钟节流；失败时回退本地缓存。 */
    JSONObject refreshProfileNow() {
        lastProfileRefresh = 0;
        try { return profile(true); }
        catch (Exception ignored) {
            try { return profile(false); }
            catch (Exception alsoIgnored) { return new JSONObject(); }
        }
    }

    JSONObject profile() throws Exception { return profile(false); }

    JSONObject refreshProfile() throws Exception {
        if (!refreshingProfile.compareAndSet(false, true)) return profile(false);
        try { return profile(true); }
        finally { refreshingProfile.set(false); }
    }

    private JSONObject profile(boolean refreshRemote) throws Exception {
        String token = prefs.getString("token", "");
        if (token.isEmpty()) return new JSONObject().put("loggedIn", false);
        String userId = prefs.getString("userId", "");
        JSONObject user = null;
        if (refreshRemote && System.currentTimeMillis() - lastProfileRefresh > 5 * 60_000L) {
            try {
                user = call("GET", "api/me", null, true).getJSONObject("user");
                lastProfileRefresh = System.currentTimeMillis();
                prefs.edit().putString("username", user.optString("username"))
                        .putBoolean("huangguoUnlocked", user.optBoolean("huangguoUnlocked", false))
                        .putString("role", user.optString("role", "user")).apply();
            } catch (Exception ignored) { /* 离线时使用本地账号资料 */ }
        }
        String username = user == null ? prefs.getString("username", "") : user.optString("username");
        JSONObject result = new JSONObject().put("loggedIn", true)
                .put("username", username).put("userId", userId)
                .put("role", prefs.getString("role", "user"))
                .put("huangguoUnlocked", prefs.getBoolean("huangguoUnlocked", false));
        File avatar = new File(new File(context.getFilesDir(), "avatars"), userId + ".jpg");
        SharedPreferences markers = context.getSharedPreferences("huangguo-avatars", Context.MODE_PRIVATE);
        String remoteAvatar = user == null ? null : user.optString("avatar", "");
        if (refreshRemote && remoteAvatar != null && !remoteAvatar.isEmpty()
                && (!avatar.isFile() || !remoteAvatar.equals(markers.getString(userId, "")))) {
            try {
                byte[] data = download(remoteAvatar.startsWith("http") ? remoteAvatar : baseUrl + remoteAvatar.replaceFirst("^/", ""));
                saveAvatar(avatar, data);
                markers.edit().putString(userId, remoteAvatar).apply();
            } catch (Exception ignored) { /* 离线时先显示默认头像 */ }
        }
        if (avatar.isFile()) {
            byte[] data = java.nio.file.Files.readAllBytes(avatar.toPath());
            result.put("avatar", "data:image/jpeg;base64," + Base64.encodeToString(data, Base64.NO_WRAP));
        }
        return result;
    }

    private static void saveAvatar(File target, byte[] data) throws Exception {
        target.getParentFile().mkdirs();
        File temporary = File.createTempFile("avatar-", ".tmp", target.getParentFile());
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(data); }
            java.nio.file.Files.move(temporary.toPath(), target.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        } finally { if (temporary.exists()) temporary.delete(); }
    }

    synchronized JSONObject register(String username, String password, String server, String code) throws Exception {
        validate(username, password);
        applyServerBase(server);
        JSONObject body = new JSONObject().put("username", username).put("password", password)
                .put("code", code == null ? "" : code).put("device", deviceModel());
        JSONObject result;
        try {
            result = call("POST", "api/register", body, false);
        } catch (AccountApiException error) {
            if (error.status == 409) throw new IllegalArgumentException("该账号已被注册");
            if (error.status == 403) throw new IllegalArgumentException(error.getMessage());
            throw error;
        }
        applyAuth(result);
        return profile(false);
    }

    synchronized JSONObject login(String username, String password, String server) throws Exception {
        validate(username, password);
        applyServerBase(server);
        JSONObject body = new JSONObject().put("username", username).put("password", password)
                .put("device", deviceModel());
        JSONObject result;
        try {
            result = call("POST", "api/login", body, false);
        } catch (AccountApiException error) {
            if (error.status == 401) throw new IllegalArgumentException("账号不存在或密码错误，请检查后重试");
            throw error;
        }
        applyAuth(result);
        return profile(false);
    }

    /** 设置后端服务器地址（登录/注册页填写，持久化；传空表示沿用当前已配置地址）。 */
    private void applyServerBase(String server) {
        if (server == null || server.trim().isEmpty()) {
            if (baseUrl.isEmpty()) throw new IllegalArgumentException("请填写服务器地址");
            return;
        }
        String normalized = ServerConfig.normalize(server);
        ServerConfig.set(context, normalized);
        this.baseUrl = normalized;
    }

    private void applyAuth(JSONObject result) throws Exception {
        String token = result.optString("token", "");
        JSONObject user = result.getJSONObject("user");
        if (token.isEmpty() || !user.has("id")) throw new IllegalStateException("后端返回数据异常，请稍后重试");
        prefs.edit().putString("token", token).putString("userId", user.getString("id"))
                .putString("username", user.optString("username", ""))
                .putString("role", user.optString("role", "user"))
                .putBoolean("huangguoUnlocked", user.optBoolean("huangguoUnlocked", false)).apply();
        store.activateUser(user.getString("id"));
    }

    synchronized JSONObject changePassword(String oldPassword, String newPassword) throws Exception {
        if (!isLoggedIn()) throw new IllegalStateException("请先登录账号");
        if (oldPassword == null || oldPassword.isEmpty()) throw new IllegalArgumentException("请输入旧密码");
        if (newPassword == null || newPassword.length() < 1) throw new IllegalArgumentException("新密码不能为空");
        if (newPassword.equals(oldPassword)) throw new IllegalArgumentException("新密码不能与旧密码相同");
        JSONObject body = new JSONObject().put("oldPassword", oldPassword).put("newPassword", newPassword);
        JSONObject result = call("POST", "api/change-password", body, true);
        applyAuth(result);
        return profile();
    }

    /** 验证私密模式动态码（后端 OTP，需登录）。验证通过后服务端给该账号永久解锁（跟账号走）。 */
    synchronized void verifyOtp(String code) throws Exception {
        if (code == null || !code.matches("\\d{6}"))
            throw new IllegalArgumentException("动态码为 6 位数字");
        call("POST", "api/otp/verify", new JSONObject().put("code", code), true);
        prefs.edit().putBoolean("huangguoUnlocked", true).apply();
    }

    /** 注册前置动态码校验（无需登录）：验证通过即可，不解锁私密模式。 */
    synchronized void verifyOtpPublic(String code, String server) throws Exception {
        if (code == null || !code.matches("\\d{6}"))
            throw new IllegalArgumentException("动态码为 6 位数字");
        applyServerBase(server);
        call("POST", "api/otp/verify", new JSONObject().put("code", code), false);
    }

    private static void validate(String username, String password) {
        if (username == null || !username.matches("[A-Za-z0-9_]{3,24}"))
            throw new IllegalArgumentException("账号需为 3–24 位字母、数字或下划线");
        if (password == null || password.length() < 1)
            throw new IllegalArgumentException("密码不能为空");
    }

    private static String deviceModel() {
        return android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL;
    }

    synchronized void logout() throws Exception {
        if (isLoggedIn()) {
            try { call("POST", "api/logout", null, true); } catch (Exception ignored) { }
            prefs.edit().clear().apply();
        }
        store.activateUser("");
    }

    synchronized JSONObject sync() throws Exception {
        if (!isLoggedIn()) return new JSONObject().put("loggedIn", false);
        store.activateUser(userId());
        String source = ContentMode.PRIVATE.equals(store.source) ? "huangguo" : "hongguo";
        JSONObject remote;
        try {
            remote = call("GET", "api/library?source=" + source, null, true);
        } catch (AccountApiException error) {
            if (error.status == 401) {
                prefs.edit().clear().apply();
                store.activateUser("");
            }
            throw error;
        }
        JSONObject local = store.cloudSnapshot();
        JSONObject merged = merge(local, remote.optJSONObject("payload") == null
                ? new JSONObject() : remote.getJSONObject("payload"));
        store.applyCloudSnapshot(merged);
        call("PUT", "api/library", new JSONObject().put("source", source).put("payload", merged), true);
        return new JSONObject().put("loggedIn", true).put("synced", true);
    }

    private static JSONObject merge(JSONObject local, JSONObject remote) throws Exception {
        JSONObject result = new JSONObject();
        mergeGroup(result, "bookmarks", "bookmarkDeleted", "addedAt", local, remote);
        mergeGroup(result, "history", "historyDeleted", "updatedAt", local, remote);
        JSONObject history = result.getJSONObject("history");
        ArrayList<String> ids = new ArrayList<>();
        for (Iterator<String> keys = history.keys(); keys.hasNext();) ids.add(keys.next());
        ids.sort((a, b) -> Long.compare(history.optJSONObject(b).optLong("updatedAt"), history.optJSONObject(a).optLong("updatedAt")));
        JSONObject deleted = result.getJSONObject("historyDeleted");
        for (int i = 50; i < ids.size(); i++) {
            String id = ids.get(i);
            deleted.put(id, Math.max(System.currentTimeMillis(), history.optJSONObject(id).optLong("updatedAt") + 1));
            history.remove(id);
        }
        return result;
    }

    private static void mergeGroup(JSONObject result, String liveKey, String deleteKey, String timestamp,
                                   JSONObject local, JSONObject remote) throws Exception {
        JSONObject localLive = local.optJSONObject(liveKey), remoteLive = remote.optJSONObject(liveKey);
        JSONObject localDeleted = local.optJSONObject(deleteKey), remoteDeleted = remote.optJSONObject(deleteKey);
        if (localLive == null) localLive = new JSONObject();
        if (remoteLive == null) remoteLive = new JSONObject();
        if (localDeleted == null) localDeleted = new JSONObject();
        if (remoteDeleted == null) remoteDeleted = new JSONObject();
        JSONObject live = new JSONObject(), deleted = new JSONObject();
        Set<String> ids = new HashSet<>();
        for (JSONObject group : new JSONObject[]{localLive, remoteLive, localDeleted, remoteDeleted})
            for (Iterator<String> keys = group.keys(); keys.hasNext();) ids.add(keys.next());
        for (String id : ids) {
            JSONObject left = localLive.optJSONObject(id), right = remoteLive.optJSONObject(id);
            JSONObject newest = right == null || (left != null && left.optLong(timestamp) > right.optLong(timestamp)) ? left : right;
            long liveAt = newest == null ? 0 : newest.optLong(timestamp);
            long deletedAt = Math.max(localDeleted.optLong(id), remoteDeleted.optLong(id));
            if (deletedAt >= liveAt && deletedAt > 0) deleted.put(id, deletedAt);
            else if (newest != null) live.put(id, newest);
        }
        result.put(liveKey, live).put(deleteKey, deleted);
    }

    synchronized JSONObject setAvatar(Uri uri) throws Exception {
        if (!isLoggedIn()) throw new IllegalStateException("请先登录");
        byte[] bytes = cropAvatar(uri);
        JSONObject body = new JSONObject().put("data",
                Base64.encodeToString(bytes, Base64.NO_WRAP));
        JSONObject result = call("POST", "api/avatar", body, true);
        String remoteAvatar = result.getJSONObject("user").optString("avatar", "");
        File local = new File(new File(context.getFilesDir(), "avatars"), userId() + ".jpg");
        saveAvatar(local, bytes);
        context.getSharedPreferences("huangguo-avatars", Context.MODE_PRIVATE)
                .edit().putString(userId(), remoteAvatar).apply();
        return profile();
    }

    private byte[] cropAvatar(Uri uri) throws Exception {
        int orientation = ExifInterface.ORIENTATION_NORMAL;
        try (InputStream input = context.getContentResolver().openInputStream(uri)) {
            orientation = new ExifInterface(input).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (Exception ignored) { }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        try (InputStream input = context.getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(input, null, options); }
        int sample = 1;
        while (Math.max(options.outWidth, options.outHeight) / sample > 768) sample *= 2;
        options.inJustDecodeBounds = false;
        options.inSampleSize = sample;
        Bitmap source;
        try (InputStream input = context.getContentResolver().openInputStream(uri)) { source = BitmapFactory.decodeStream(input, null, options); }
        if (source == null) throw new IllegalArgumentException("无法读取这张图片");
        int rotation = orientation == ExifInterface.ORIENTATION_ROTATE_90 ? 90 :
                orientation == ExifInterface.ORIENTATION_ROTATE_180 ? 180 :
                        orientation == ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
        if (rotation != 0) {
            Matrix matrix = new Matrix();
            matrix.postRotate(rotation);
            Bitmap rotated = Bitmap.createBitmap(source, 0, 0, source.getWidth(), source.getHeight(), matrix, true);
            source.recycle();
            source = rotated;
        }
        int side = Math.min(source.getWidth(), source.getHeight());
        Bitmap square = Bitmap.createBitmap(source, (source.getWidth() - side) / 2, (source.getHeight() - side) / 2, side, side);
        Bitmap resized = Bitmap.createScaledBitmap(square, 256, 256, true);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        resized.compress(Bitmap.CompressFormat.JPEG, 85, output);
        if (resized != square) resized.recycle();
        if (square != source) square.recycle();
        source.recycle();
        return output.toByteArray();
    }

    /** 后端 HTTP 调用。非 2xx 抛 AccountApiException（带服务端 error 文案）；网络异常原样抛出。 */
    private JSONObject call(String method, String path, JSONObject body, boolean auth) throws Exception {
        if (baseUrl == null || baseUrl.trim().isEmpty()) {
            throw new IllegalStateException("服务器地址未设置：请到登录页重新填写服务器地址并登录，再使用下载到 NAS");
        }
        Request.Builder builder = new Request.Builder().url(baseUrl + path);
        if (body != null) builder.method(method, RequestBody.create(JSON, body.toString()));
        else builder.method(method, null);
        if (auth) builder.header("Authorization", "Bearer " + prefs.getString("token", ""));
        try (Response response = client.newCall(builder.build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            JSONObject json = null;
            try { if (!text.isEmpty()) json = new JSONObject(text); } catch (Exception ignored) { }
            if (!response.isSuccessful()) {
                String message = json != null ? json.optString("error", "") : "";
                if (message.isEmpty()) message = "后端请求失败（HTTP " + response.code() + "）";
                throw new AccountApiException(response.code(), message);
            }
            if (json == null) return new JSONObject();
            return json;
        }
    }

    /** 登录态后端请求（NAS 下载任务等），给 MainActivity dispatch 使用。 */
    JSONObject postJson(String path, JSONObject body) throws Exception {
        if (!isLoggedIn()) throw new IllegalStateException("请先登录");
        return call("POST", path, body, true);
    }
    JSONObject getJson(String path) throws Exception {
        if (!isLoggedIn()) throw new IllegalStateException("请先登录");
        return call("GET", path, null, true);
    }
    void deleteJson(String path) throws Exception {
        if (!isLoggedIn()) throw new IllegalStateException("请先登录");
        call("DELETE", path, null, true);
    }

    /** 登录态二进制下载（转发模式：手机从 NAS 拉取已下载的单集 mp4）。 */
    byte[] getBytes(String path) throws Exception {
        if (!isLoggedIn()) throw new IllegalStateException("请先登录");
        Request.Builder builder = new Request.Builder().url(baseUrl + path);
        builder.header("Authorization", "Bearer " + prefs.getString("token", ""));
        try (Response response = client.newCall(builder.build()).execute()) {
            if (!response.isSuccessful()) {
                String message = "";
                try { if (response.body() != null) message = new JSONObject(response.body().string()).optString("error", ""); } catch (Exception ignored) { }
                if (message.isEmpty()) message = "拉取失败（HTTP " + response.code() + "）";
                throw new AccountApiException(response.code(), message);
            }
            if (response.body() == null) throw new java.io.IOException("拉取内容为空");
            return response.body().bytes();
        }
    }

    private byte[] download(String address) throws Exception {
        Request request = new Request.Builder().url(address).build();
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null)
                throw new IllegalStateException("头像下载失败（HTTP " + response.code() + "）");
            return response.body().bytes();
        }
    }

    private static final class AccountApiException extends Exception {
        final int status;
        AccountApiException(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
