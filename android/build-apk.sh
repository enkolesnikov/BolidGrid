#!/usr/bin/env bash
# Сборка APK BolidGrid без Gradle: aapt (ресурсы) + javac + d8 + zipalign + apksigner.
#
# Требуется Android SDK с platform android-37.x (Android 17) и build-tools 37.0.0.
# Путь к SDK: $ANDROID_SDK_ROOT / $ANDROID_HOME, android/local.properties (sdk.dir=…)
# или локальная папка .android-sdk в корне проекта.
#
# Переменные: VERSION_NAME, VERSION_CODE, ANDROID_PLATFORM, BUILD_TOOLS_VERSION,
#             ALLOW_NEW_KEYSTORE=1 (создать ключ подписи при первой сборке).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
BUILD_DIR="$ROOT/build"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [ -z "$SDK" ] && [ -f "$ANDROID_DIR/local.properties" ]; then
    SDK="$(sed -n 's/^sdk.dir=//p' "$ANDROID_DIR/local.properties")"
fi
if [ -z "$SDK" ] && [ -d "$ROOT/.android-sdk/platforms" ]; then
    SDK="$ROOT/.android-sdk"
fi
SDK="${SDK:-/root/Android/Sdk}"
PLATFORM="${ANDROID_PLATFORM:-android-37.2}"
BT_VERSION="${BUILD_TOOLS_VERSION:-37.0.0}"
ANDROID_JAR="$SDK/platforms/$PLATFORM/android.jar"
BT_DIR="$SDK/build-tools/$BT_VERSION"
AAPT="$BT_DIR/aapt"
ZIPALIGN="$BT_DIR/zipalign"
APKSIGNER="$BT_DIR/apksigner"
D8="$BT_DIR/d8"
PACKAGE="com.bolidgrid.app"
VERSION_NAME="${VERSION_NAME:-1.5.0}"
VERSION_CODE="${VERSION_CODE:-6}"
OUT_APK="$BUILD_DIR/BolidGrid-${VERSION_NAME}.apk"
KEYSTORE="$ANDROID_DIR/keystore/bolidgrid.jks"
KS_PASS_FILE="$ANDROID_DIR/keystore/pass.txt"
KS_ALIAS="bolidgrid"
KS_PASS="${KS_PASS:-}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die() { echo "Ошибка: $1" >&2; exit 1; }

[ -f "$ANDROID_JAR" ] || die "нет $ANDROID_JAR — установите platform $PLATFORM или задайте ANDROID_SDK_ROOT"
[ -x "$AAPT" ] || die "нет $AAPT — установите build-tools $BT_VERSION"
[ -x "$D8" ] || die "нет $D8"
need() { command -v "$1" >/dev/null 2>&1 || die "не найдено: $1"; }
need javac; need java; need zip; need keytool

say "1/6 Копирование веб-приложения в assets/www"
rm -rf "$ANDROID_DIR/assets"
WWW="$ANDROID_DIR/assets/www"
mkdir -p "$WWW/js" "$WWW/css" "$WWW/data"
cp "$ROOT/index.html" "$WWW/"
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));fs.writeFileSync(process.argv[2],JSON.stringify(p))" "$ROOT/data/spec.json" "$WWW/data/spec.json"
ESBUILD="$ROOT/node_modules/.bin/esbuild"
if [ -x "$ESBUILD" ] && [ "${MINIFY:-1}" != "0" ]; then
    # минификация без изменения структуры ES-модулей: меньше APK и быстрее первый разбор
    for f in "$ROOT"/js/*.js; do
        "$ESBUILD" "$f" --minify --format=esm --outfile="$WWW/js/$(basename "$f")" --log-level=error
    done
    "$ESBUILD" "$ROOT/css/app.css" --minify --outfile="$WWW/css/app.css" --log-level=error
    echo "    JS/CSS минифицированы"
else
    cp -a "$ROOT/js" "$ROOT/css" "$WWW/"
    echo "    esbuild не найден — ассеты скопированы как есть (MINIFY=0)"
fi

say "2/6 Компиляция ресурсов и манифеста (aapt)"
rm -rf "$BUILD_DIR/gen" "$BUILD_DIR/classes" "$BUILD_DIR/dex"
mkdir -p "$BUILD_DIR/gen" "$BUILD_DIR/classes" "$BUILD_DIR/dex"
"$AAPT" package -f -m \
    -J "$BUILD_DIR/gen" \
    -M "$ANDROID_DIR/AndroidManifest.xml" \
    -S "$ANDROID_DIR/res" \
    -I "$ANDROID_JAR" \
    --min-sdk-version 26 \
    --target-sdk-version 37 \
    --version-code "$VERSION_CODE" \
    --version-name "$VERSION_NAME" \
    --rename-manifest-package "$PACKAGE"

say "3/6 Компиляция Java и dex (javac + d8)"
find "$ANDROID_DIR/java" -name '*.java' > "$BUILD_DIR/sources.txt"
javac -nowarn -encoding UTF-8 -source 8 -target 8 \
    -bootclasspath "$ANDROID_JAR" \
    -d "$BUILD_DIR/classes" \
    @"$BUILD_DIR/sources.txt"
find "$BUILD_DIR/classes" -name '*.class' > "$BUILD_DIR/classes.txt"
"$D8" --release --min-api 26 --lib "$ANDROID_JAR" --output "$BUILD_DIR/dex" @"$BUILD_DIR/classes.txt"

say "4/6 Упаковка и выравнивание (aapt + zip + zipalign)"
UNSIGNED="$BUILD_DIR/bolidgrid-unsigned.apk"
ALIGNED="$BUILD_DIR/bolidgrid-aligned.apk"
rm -f "$UNSIGNED" "$ALIGNED"
"$AAPT" package -f \
    -M "$ANDROID_DIR/AndroidManifest.xml" \
    -S "$ANDROID_DIR/res" \
    -A "$ANDROID_DIR/assets" \
    -I "$ANDROID_JAR" \
    -F "$UNSIGNED" \
    --min-sdk-version 26 \
    --target-sdk-version 37 \
    --version-code "$VERSION_CODE" \
    --version-name "$VERSION_NAME" \
    --rename-manifest-package "$PACKAGE"
( cd "$BUILD_DIR/dex" && zip -q -X -0 "$UNSIGNED" classes.dex )
"$ZIPALIGN" -p -f 4 "$UNSIGNED" "$ALIGNED"

say "5/6 Ключ подписи"
if [ ! -f "$KEYSTORE" ]; then
    if [ "${ALLOW_NEW_KEYSTORE:-0}" != "1" ]; then
        die "нет $KEYSTORE. Для первой сборки: ALLOW_NEW_KEYSTORE=1 bash android/build-apk.sh"
    fi
    mkdir -p "$(dirname "$KEYSTORE")"
    if [ -z "$KS_PASS" ]; then
        KS_PASS="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
    fi
    keytool -genkeypair -v \
        -keystore "$KEYSTORE" \
        -alias "$KS_ALIAS" \
        -keyalg RSA -keysize 2048 -validity 10950 \
        -dname "CN=BolidGrid, O=BolidGrid, C=RU" \
        -storepass "$KS_PASS" -keypass "$KS_PASS" >/dev/null
    printf '%s' "$KS_PASS" > "$KS_PASS_FILE"
    chmod 600 "$KS_PASS_FILE"
    echo "Создан ключ подписи: $KEYSTORE (пароль в $KS_PASS_FILE)"
fi
[ -n "$KS_PASS" ] || KS_PASS="$(cat "$KS_PASS_FILE" 2>/dev/null || true)"
[ -n "$KS_PASS" ] || die "не найден пароль keystore: задайте KS_PASS"

say "6/6 Подпись (apksigner)"
rm -f "$OUT_APK"
"$APKSIGNER" sign \
    --ks "$KEYSTORE" \
    --ks-pass "pass:$KS_PASS" \
    --key-pass "pass:$KS_PASS" \
    --v1-signing-enabled true \
    --v2-signing-enabled true \
    --v3-signing-enabled true \
    --out "$OUT_APK" \
    "$ALIGNED"
"$APKSIGNER" verify --verbose "$OUT_APK" | sed 's/^/    /'

say "Готово"
ls -lh "$OUT_APK"
"$AAPT" dump badging "$OUT_APK" | head -8
