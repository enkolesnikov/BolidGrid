package com.bolidgrid.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Отдаёт статическую сборку из assets/www по origin https://appassets.local/.
 * Запросы к /api/* отвечают 404 — приложение само переключается в режим хранения «Браузер».
 */
public class AssetServer extends WebViewClient {

    static final String HOST = "appassets.local";
    static final String START_URL = "https://" + HOST + "/";

    private final Context context;

    AssetServer(Context context) {
        this.context = context.getApplicationContext();
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null || !HOST.equals(uri.getHost())) return null;

        String path = uri.getPath();
        if (path == null || path.isEmpty()) path = "/";

        if (path.startsWith("/api/")) {
            return new WebResourceResponse("application/json", "utf-8", 404, "Not Found",
                    headers(), new ByteArrayInputStream("{\"error\":\"offline\"}".getBytes()));
        }
        if (path.equals("/")) path = "/index.html";

        InputStream stream = openAsset("www" + path);
        if (stream != null) return response(mimeOf(path), stream);

        // Одностраничное приложение: неизвестные адреса без расширения отдаём как index.html.
        if (!path.substring(path.lastIndexOf('/') + 1).contains(".")) {
            InputStream index = openAsset("www/index.html");
            if (index != null) return response("text/html", index);
        }
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                headers(), new ByteArrayInputStream("Not found".getBytes()));
    }

    private InputStream openAsset(String path) {
        try {
            return context.getAssets().open(path);
        } catch (IOException e) {
            return null;
        }
    }

    private static WebResourceResponse response(String mime, InputStream stream) {
        String encoding = null;
        if (mime.startsWith("text/")) encoding = "utf-8";
        else if (mime.equals("application/json")
                || mime.equals("application/javascript")
                || mime.equals("image/svg+xml")) encoding = "utf-8";
        return new WebResourceResponse(mime, encoding, 200, "OK", headers(), stream);
    }

    private static Map<String, String> headers() {
        Map<String, String> result = new HashMap<>();
        result.put("Cache-Control", "no-cache");
        return result;
    }

    private static String mimeOf(String path) {
        String lower = path.toLowerCase();
        int dot = lower.lastIndexOf('.');
        String ext = dot >= 0 ? lower.substring(dot + 1) : "";
        switch (ext) {
            case "html": return "text/html";
            case "js":
            case "mjs": return "application/javascript";
            case "css": return "text/css";
            case "json": return "application/json";
            case "png": return "image/png";
            case "jpg":
            case "jpeg": return "image/jpeg";
            case "svg": return "image/svg+xml";
            case "webp": return "image/webp";
            case "ico": return "image/x-icon";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "ttf": return "font/ttf";
            case "wasm": return "application/wasm";
            case "pdf": return "application/pdf";
            case "txt": return "text/plain";
            default: return "application/octet-stream";
        }
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null) return false;
        if (HOST.equals(uri.getHost())) return false;
        String scheme = uri.getScheme();
        if ("http".equals(scheme) || "https".equals(scheme) || "mailto".equals(scheme) || "tel".equals(scheme)) {
            try {
                view.getContext().startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
                // внешнее приложение недоступно — остаёмся в приложении
            }
            return true;
        }
        return false;
    }
}
