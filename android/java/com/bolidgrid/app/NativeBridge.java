package com.bolidgrid.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Мост из веб-части в Android: сохранение экспортированных файлов (JSON/SVG/CSV/MD)
 * в «Загрузки/BolidGrid» и печать листа. Вызывается только если страница нашла
 * window.BolidGridNative (см. js/util.js).
 */
public class NativeBridge {

    private final MainActivity activity;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void saveFile(String name, String base64, String mime) {
        final String fileName = sanitize(name);
        final String type = (mime == null || mime.isEmpty())
                ? "application/octet-stream" : mime;
        final byte[] data;
        try {
            data = Base64.decode(base64, Base64.DEFAULT);
        } catch (Exception e) {
            toast("Не удалось сохранить файл: " + e.getMessage());
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String message = write(fileName, type, data);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        toast(message);
                    }
                });
            }
        }).start();
    }

    @JavascriptInterface
    public void printPage() {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.printPage();
            }
        });
    }

    @JavascriptInterface
    public void toastMessage(String text) {
        toast(text);
    }

    private void toast(final String text) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(activity, text, Toast.LENGTH_LONG).show();
            }
        });
    }

    private static String sanitize(String name) {
        String result = name == null ? "" : name.trim();
        result = result.replace('/', '_').replace('\\', '_').replace('\u0000', '_');
        if (result.isEmpty()) result = "BolidGrid";
        if (result.length() > 120) result = result.substring(0, 120);
        return result;
    }

    private String write(String fileName, String mime, byte[] data) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = activity.getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/BolidGrid");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return "Не удалось создать файл в Загрузках";
                OutputStream stream = resolver.openOutputStream(uri);
                if (stream == null) return "Не удалось открыть файл для записи";
                try {
                    stream.write(data);
                } finally {
                    stream.close();
                }
                values.clear();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(uri, values, null, null);
                return "Сохранено: Загрузки/BolidGrid/" + fileName;
            }
            File dir = new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "BolidGrid");
            if (!dir.exists() && !dir.mkdirs()) return "Не удалось создать каталог для файлов";
            File out = new File(dir, fileName);
            FileOutputStream stream = new FileOutputStream(out);
            try {
                stream.write(data);
            } finally {
                stream.close();
            }
            return "Сохранено: " + out.getAbsolutePath();
        } catch (Exception e) {
            return "Ошибка сохранения: " + e.getMessage();
        }
    }
}
