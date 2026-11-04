# BolidGrid для Android (APK)

Нативная оболочка вокруг того же офлайн-веб-приложения: `WebView` + локальные ассеты
(без интернета), сохранение экспортов в «Загрузки/BolidGrid», системная печать.
Приложение — тонкая оболочка: интерфейс, геометрия и данные те же, что на сайте.

## Что внутри

| Параметр | Значение |
|---|---|
| Пакет | `com.bolidgrid.app` |
| Мин. Android | 8.0 (API 26) |
| Целевой Android | **17 (API 37)**, `compileSdk 37` |
| Разрешения | нет (сеть не нужна) |
| Хранение проекта | `localStorage` внутри WebView (как на сайте) |
| Экспорт | JSON/SVG/CSV/MD → `Загрузки/BolidGrid` |
| Печать | системный `PrintManager` |

Ассеты `assets/www/` — статическая версия сайта (`index.html`, `css/`, `js/`, `data/spec.json`).
Она отдаётся `AssetServer` по защищённому origin `https://appassets.local/`, поэтому в WebView
работают `localStorage` и обычный `fetch('data/spec.json')`.

## Сборка

Нужны Android SDK platform `android-37.2` и build-tools `37.0.0` (Android 17), JDK 17+.
Путь к SDK берётся из `ANDROID_SDK_ROOT`/`ANDROID_HOME`, `android/local.properties`
(`sdk.dir=…`) или из локальной папки `.android-sdk/`.

```bash
# первая сборка создаёт ключ подписи android/keystore/ (в git не попадает)
ALLOW_NEW_KEYSTORE=1 bash android/build-apk.sh

# последующие сборки
bash android/build-apk.sh
```

Результат: `build/BolidGrid-<версия>.apk`. Скрипт делает всё без Gradle:
`aapt` (ресурсы/manifest) → `javac` → `d8` → `zipalign` → `apksigner` (v2+v3).

Версия задаётся `VERSION_NAME`/`VERSION_CODE`:

```bash
VERSION_NAME=1.0.1 VERSION_CODE=2 bash android/build-apk.sh
```

## Установка на телефон

1. Скачайте APK (GitHub Releases → «BolidGrid … Android APK»).
2. Откройте файл на телефоне, разрешите установку из этого источника.
3. Приложение работает офлайн; проект сохраняется автоматически.
4. Для резервной копии — «Меню → Экспорт JSON»: файл появится в «Загрузки/BolidGrid».

## Ограничения

- Обновление — установкой нового APK поверх старого (данные WebView сохраняются).
- Отдельного «Поделиться» и открытия файла из файлового менеджера нет: импорт — через кнопку
  «Меню → Импорт JSON» в приложении.
- APK собран и подписан локальным ключом; для публикации в Google Play нужен собственный
  ключ и подпись через Play Console.
