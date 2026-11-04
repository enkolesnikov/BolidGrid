package com.bolidgrid.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.DialogInterface;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * BolidGrid — офлайн-оболочка Android вокруг монтажного плана стены.
 *
 * Статическая версия веб-приложения лежит в assets/www и отдаётся WebView через
 * {@link AssetServer} по защищённому origin https://appassets.local/, поэтому в WebView
 * работают localStorage и обычный fetch() к data/spec.json. Сеть приложению не нужна.
 */
public class MainActivity extends Activity {

    private static final int REQUEST_FILE_CHOOSER = 1001;
    private static final int REQUEST_STORAGE = 1002;
    private static final String BG = "#0B1220";

    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;
    private Runnable pendingStorageAction;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor(BG));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor(BG));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " BolidGridApp/1.0");

        webView.setWebViewClient(new AssetServer(this));
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                Intent intent = null;
                try {
                    intent = params.createIntent();
                } catch (Exception ignored) {
                    // ниже — запасной вариант
                }
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                }
                try {
                    startActivityForResult(intent, REQUEST_FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileChooserCallback = null;
                    Toast.makeText(MainActivity.this, "Не найдено приложение для выбора файла",
                            Toast.LENGTH_SHORT).show();
                    return false;
                }
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("ОК", new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                result.confirm();
                            }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override
                            public void onCancel(DialogInterface dialog) {
                                result.cancel();
                            }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("ОК", new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                result.confirm();
                            }
                        })
                        .setNegativeButton("Отмена", new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                result.cancel();
                            }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override
                            public void onCancel(DialogInterface dialog) {
                                result.cancel();
                            }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue,
                                      final JsPromptResult result) {
                final EditText input = new EditText(MainActivity.this);
                input.setText(defaultValue);
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setView(input)
                        .setPositiveButton("ОК", new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                result.confirm(input.getText().toString());
                            }
                        })
                        .setNegativeButton("Отмена", new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                result.cancel();
                            }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override
                            public void onCancel(DialogInterface dialog) {
                                result.cancel();
                            }
                        })
                        .show();
                return true;
            }
        });
        webView.addJavascriptInterface(new NativeBridge(this), "BolidGridNative");
        webView.loadUrl(AssetServer.START_URL);

        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor(BG));
        window.setNavigationBarColor(Color.parseColor(BG));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                    android.graphics.Insets bars = insets.getInsets(
                            WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                    return insets;
                }
            });
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FILE_CHOOSER || fileChooserCallback == null) return;
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        fileChooserCallback.onReceiveValue(results);
        fileChooserCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            // debounce автосохранения (500 мс) мог не сработать — фиксируем проект в localStorage
            webView.evaluateJavascript(
                    "window.BolidGrid&&window.BolidGrid.store&&window.BolidGrid.store.save();", null);
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("BolidGridNative");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    WebView getWebView() {
        return webView;
    }

    /** Есть ли доступ к общим «Загрузкам» (Android 8–9 требует разрешение). */
    boolean hasLegacyStoragePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return true;
        return checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** Выполнить сохранение; на Android 8–9 при необходимости сначала спросить разрешение. */
    void withStoragePermission(Runnable action) {
        if (hasLegacyStoragePermission()) {
            action.run();
            return;
        }
        pendingStorageAction = action;
        requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQUEST_STORAGE);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_STORAGE) return;
        Runnable action = pendingStorageAction;
        pendingStorageAction = null;
        if (action == null) return;
        // при отказе сохраняем в папку приложения, но не теряем данные
        action.run();
    }

    /** Печать листа через системный PrintManager (PDF/принтер). */
    void printPage() {
        if (webView == null) return;
        try {
            android.print.PrintManager pm =
                    (android.print.PrintManager) getSystemService(PRINT_SERVICE);
            if (pm == null) return;
            pm.print("BolidGrid", webView.createPrintDocumentAdapter("BolidGrid"), null);
        } catch (Exception e) {
            Toast.makeText(this, "Печать недоступна: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }
}
