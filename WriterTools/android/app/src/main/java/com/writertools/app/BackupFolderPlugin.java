package com.writertools.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * WriterTools 原生备份目录插件（Android Storage Access Framework）。
 *
 * Web 端 File System Access API 在 Android WebView 不可用，这里用系统目录选择器
 * （ACTION_OPEN_DOCUMENT_TREE）选择任意可写文件夹，并通过 ContentResolver 读写
 * writertools-manifest.json / *.wtlog 文本文件；URI 权限用 takePersistableUriPermission
 * 持久化，重启 App 后仍然有效。
 */
@CapacitorPlugin(name = "BackupFolder")
public class BackupFolderPlugin extends Plugin {

    private static final String TAG = "WriterToolsBackup";
    private static final String PREFS = "writertools_backup";
    private static final String KEY_TREE_URI = "tree_uri";
    private static final String MANIFEST_NAME = "writertools-manifest.json";
    private static final int MAX_FILE_BYTES = 32 * 1024 * 1024;
    private static final int MAX_FILES = 500;

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private DocumentFile selectedTree() {
        String uriString = prefs().getString(KEY_TREE_URI, null);
        if (uriString == null || uriString.isEmpty()) return null;
        try {
            Uri uri = Uri.parse(uriString);
            if (!DocumentsContract.isTreeUri(uri)) return null;
            DocumentFile tree = DocumentFile.fromTreeUri(getContext(), uri);
            if (tree == null || !tree.exists() || !tree.canWrite()) return null;
            return tree;
        } catch (Exception error) {
            Log.w(TAG, "读取备份目录失败", error);
            return null;
        }
    }

    private JSObject nameResult(String name) {
        JSObject result = new JSObject();
        result.put("name", name);
        return result;
    }

    /** 弹出系统文件夹选择器（必须由用户点击触发）。 */
    @PluginMethod
    public void chooseDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "directoryPicked");
    }

    @ActivityCallback
    private void directoryPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve(nameResult(null));
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.resolve(nameResult(null));
            return;
        }
        int takeFlags = result.getData().getFlags()
                & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (takeFlags == 0) {
            takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, takeFlags);
            prefs().edit().putString(KEY_TREE_URI, uri.toString()).apply();
            DocumentFile tree = DocumentFile.fromTreeUri(getContext(), uri);
            String name = tree != null && tree.getName() != null ? tree.getName() : "备份目录";
            Log.i(TAG, "已选择备份目录: " + name);
            call.resolve(nameResult(name));
        } catch (Exception error) {
            Log.e(TAG, "保存目录权限失败", error);
            call.reject("保存目录权限失败：" + error.getMessage());
        }
    }

    /** 返回已持久化的目录；未选择或权限失效返回 name=null。 */
    @PluginMethod
    public void getDirectory(PluginCall call) {
        DocumentFile tree = selectedTree();
        call.resolve(nameResult(tree == null ? null : tree.getName()));
    }

    /** 覆盖写入一个文本文件。 */
    @PluginMethod
    public void writeFile(PluginCall call) {
        String name = call.getString("name");
        String data = call.getString("data");
        if (name == null || name.isEmpty() || data == null) {
            call.reject("缺少文件名或内容");
            return;
        }
        if (name.contains("/") || name.contains("\\") || name.contains("..")) {
            call.reject("非法文件名：" + name);
            return;
        }
        io.execute(() -> {
            try {
                DocumentFile tree = selectedTree();
                if (tree == null) throw new IOException("备份目录不可读写，请重新选择目录");
                DocumentFile target = ensureFile(tree, name);
                try (OutputStream output = getContext().getContentResolver().openOutputStream(target.getUri(), "wt")) {
                    if (output == null) throw new IOException("无法打开文件写入流：" + name);
                    output.write(data.getBytes(StandardCharsets.UTF_8));
                }
                call.resolve(new JSObject());
            } catch (Exception error) {
                Log.e(TAG, "写入备份文件失败: " + name, error);
                call.reject("写入备份文件失败：" + error.getMessage());
            }
        });
    }

    /**
     * 找到精确文件名的文件；没有则创建，并把 SAF 自动追加的扩展名/重名后缀改回精确名字。
     * 很多 DocumentsProvider 对 text/plain 会把 "x.wtlog" 改成 "x.wtlog.txt"；不修正的话
     * 每次备份都会认为是新文件，目录里会不断出现 (1)(2) 副本。
     */
    private DocumentFile ensureFile(DocumentFile tree, String name) throws IOException {
        for (DocumentFile file : tree.listFiles()) {
            if (name.equals(file.getName())) return file;
        }
        String mime = name.endsWith(".json") ? "application/json" : "text/plain";
        DocumentFile created = tree.createFile(mime, name);
        if (created == null) throw new IOException("无法创建文件：" + name);
        if (name.equals(created.getName())) return created;
        try {
            Uri renamedUri = DocumentsContract.renameDocument(
                    getContext().getContentResolver(), created.getUri(), name);
            if (renamedUri != null) {
                DocumentFile renamed = DocumentFile.fromSingleUri(getContext(), renamedUri);
                if (renamed != null && name.equals(renamed.getName())) {
                    Log.i(TAG, "SAF 文件名已修正: " + created.getName() + " -> " + name);
                    return renamed;
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "SAF 重命名失败: " + name, error);
        }
        return created;
    }

    /** 读取单个文本文件；不存在返回 text=null。 */
    @PluginMethod
    public void readFile(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.isEmpty()) {
            call.reject("缺少文件名");
            return;
        }
        io.execute(() -> {
            JSObject result = new JSObject();
            try {
                DocumentFile tree = selectedTree();
                if (tree == null) throw new IOException("备份目录不可读，请重新选择目录");
                DocumentFile fallback = null;
                for (DocumentFile file : tree.listFiles()) {
                    String actual = file.getName();
                    if (actual == null) continue;
                    if (name.equals(actual)) {
                        result.put("text", readText(file));
                        call.resolve(result);
                        return;
                    }
                    if ((name + ".txt").equals(actual)) {
                        if (fallback == null || file.lastModified() > fallback.lastModified()) fallback = file;
                    }
                }
                result.put("text", fallback == null ? null : readText(fallback));
                call.resolve(result);
            } catch (Exception error) {
                Log.e(TAG, "读取备份文件失败: " + name, error);
                call.reject("读取备份文件失败：" + error.getMessage());
            }
        });
    }

    /** 读取目录内全部文本文件（供「从备份目录恢复」使用）。 */
    @PluginMethod
    public void readFiles(PluginCall call) {
        io.execute(() -> {
            JSObject result = new JSObject();
            JSArray files = new JSArray();
            try {
                DocumentFile tree = selectedTree();
                if (tree == null) throw new IOException("备份目录不可读，请重新选择目录");
                Map<String, DocumentFile> selected = new LinkedHashMap<>();
                for (DocumentFile file : tree.listFiles()) {
                    if (!file.isFile()) continue;
                    String actual = file.getName();
                    if (actual == null) continue;
                    String normalized = normalizeBackupName(actual);
                    if (normalized == null) continue;
                    if (file.length() > MAX_FILE_BYTES) continue;
                    DocumentFile existing = selected.get(normalized);
                    if (existing == null) {
                        selected.put(normalized, file);
                    } else {
                        boolean exact = normalized.equals(actual);
                        boolean existingExact = normalized.equals(existing.getName());
                        if (exact && !existingExact) selected.put(normalized, file);
                        else if (exact == existingExact && file.lastModified() > existing.lastModified()) {
                            selected.put(normalized, file);
                        }
                    }
                }
                int count = 0;
                for (Map.Entry<String, DocumentFile> item : selected.entrySet()) {
                    if (count >= MAX_FILES) break;
                    JSObject entry = new JSObject();
                    entry.put("name", item.getKey());
                    entry.put("text", readText(item.getValue()));
                    files.put(entry);
                    count += 1;
                }
                result.put("files", files);
                call.resolve(result);
            } catch (Exception error) {
                Log.e(TAG, "读取备份目录失败", error);
                call.reject("读取备份目录失败：" + error.getMessage());
            }
        });
    }

    /** 忘记已选目录（不删除文件）。 */
    @PluginMethod
    public void forgetDirectory(PluginCall call) {
        try {
            String uriString = prefs().getString(KEY_TREE_URI, null);
            if (uriString != null) {
                try {
                    getContext().getContentResolver().releasePersistableUriPermission(
                            Uri.parse(uriString),
                            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                } catch (Exception ignored) {
                    // 权限可能已被系统收回，忽略
                }
            }
            prefs().edit().remove(KEY_TREE_URI).apply();
        } finally {
            call.resolve(new JSObject());
        }
    }

    /** 旧版本可能被 SAF 自动加上 .txt；读取时归一化，保证恢复能识别。 */
    private String normalizeBackupName(String name) {
        if (MANIFEST_NAME.equals(name) || name.endsWith(".wtlog")) return name;
        if (name.endsWith(".wtlog.txt")) return name.substring(0, name.length() - 4);
        if ((MANIFEST_NAME + ".txt").equals(name)) return MANIFEST_NAME;
        return null;
    }

    private String readText(DocumentFile file) throws IOException {
        try (InputStream input = getContext().getContentResolver().openInputStream(file.getUri())) {
            if (input == null) throw new IOException("无法打开文件：" + file.getName());
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = input.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
                if (buffer.size() > MAX_FILE_BYTES) throw new IOException("文件过大：" + file.getName());
            }
            return buffer.toString("UTF-8");
        }
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdownNow();
        super.handleOnDestroy();
    }
}
