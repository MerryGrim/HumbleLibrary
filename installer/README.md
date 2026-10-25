# Humble Library Setup

Классический пошаговый установщик в Mira Mint, адаптированный из текущего
MiraLabel installer. Win32-оболочка выбора языка, главное окно Inno и собственные
окна выбора папки/отмены используют светлую или тёмную тему Windows, встроенный X,
перетаскивание за верхнюю область и DWM corners на Windows 11. На системах, где
DWM не применяет скругление, остаётся прямоугольное окно без обрезки HRGN.

Поддерживаются **все девять языков приложения**: Русский, English, Deutsch,
Italiano, Español, Français, 简体中文, 日本語, 한국어. Переведены выбор языка,
шаги Inno, приветствие, завершение, Browse, подтверждение отмены, ошибки оболочки
и пояснение перед лицензией. Оригинальные MIT и Microsoft STL license включены
без изменения их юридического текста.

Порядок: язык → приветствие → лицензия и принятие → папка → необязательный
ярлык рабочего стола → готовность → установка → завершение. Tab, Space, Enter и
Esc сохраняют штатные действия. X/Esc/отмена подтверждения оставляют мастер;
явный выход передаёт отмену штатному rollback Inno. Приложение не запускается.

Установка только для текущего пользователя, без администратора, автозапуска и
сетевых загрузок. По умолчанию `%LOCALAPPDATA%\Programs\HumbleLibrary`; прежний
установленный путь восстанавливается через неизменный AppId
`{F016A35B-FA4D-4E51-B2D6-6F8E59E6E804}`. Папки переносимой версии и неизвестной
копии EXE отклоняются. Работающее/заблокированное приложение требуется закрыть;
Setup не завершает его процесс.

Payload содержит только `HumbleLibrary.exe`, `README.md`, `LICENSE`,
`THIRD_PARTY_NOTICES.md` и точный `installed.marker` для native installed mode:

```json
{"schema":1,"application":"HumbleLibrary","scope":"current-user"}
```

`portable.marker`, аккаунты, ключи, Data, профили браузера и signing keys в payload
не включаются. Стандартный Inno uninstaller находится в `.uninstall/`.
Деинсталляция удаляет только зарегистрированные установкой файлы и ярлыки;
`%LOCALAPPDATA%\HumbleLibrary\Data` и неизвестные пользовательские файлы не
удаляются. Стандартный uninstaller и системные ошибки Windows не объявляются
перерисованными в Mira Mint.

## Сборка

Нужны PowerShell 7, Node.js (как для приложения), Inno Setup 7 и MSVC Desktop C++
с Windows SDK. По умолчанию компилятор Inno:
`D:\AI\Tools\InnoSetup7\ISCC.exe`; MSVC определяется через vswhere.
Разработчик может явно передать `-IsccPath` и `-VisualStudioPath`.

```powershell
pwsh -NoProfile -File .\installer\build-installer.ps1 `
  -InputPath 'D:\AI\Projects\HumbleLibrary\Releases\0.2.0\installer-input' `
  -OutputPath 'D:\AI\Projects\HumbleLibrary\Releases\0.2.0'
```

`InputPath` — замороженная папка с четырьмя release-файлами. Маркер portable или
installed допускается как входная метка, но portable не встраивается. Другие
файлы/папки, reparse points, версия EXE, отличная от `source/package.json`, и
существующий выходной файл отклоняются. Версия берётся из package.json; имя
`HumbleLibrary-<version>-Setup-Windows-x64.exe` не задано вручную.

Сборка компилирует Inno и bootstrap, но не запускает Setup или приложение.
В ignored `installer/work/` сохраняются промежуточные файлы. Рядом с Setup:
`.build.json`, `.payload.json`, `.exe.bootstrap.json` фиксируют хеши/размеры
готового EXE, inner Setup, компиляторов, payload, переводов и исходников.
Стабильность входных файлов проверяется повторно после компиляции.

Редактирование переводов: `languages.json` →
`node installer/generate-resources.cjs`. Проверка без изменений:

```powershell
node .\installer\generate-resources.cjs --check
node .\verification\test-installer.cjs
```

## Изолированная QA-сборка

```powershell
pwsh -NoProfile -File .\installer\build-installer.ps1 `
  -InputPath 'D:\AI\Projects\HumbleLibrary\Releases\0.2.0\installer-input' `
  -OutputPath 'D:\AI\Projects\HumbleLibrary\verification\current\installer-qa-UNIQUE\package' `
  -QaFixture `
  -QaTargetPath 'D:\AI\Projects\HumbleLibrary\verification\current\installer-qa-UNIQUE\app'
```

QA использует отдельный AppId `{143F965D-8D2E-46BA-A48B-A9150F63C7AC}`,
имя ярлыка/деинсталляции `Humble Library Installer QA`, отдельный registry lookup
bootstrap и имя файла с `-QA`. Путь по умолчанию обязан находиться внутри
`verification/current`. UI и payload совпадают с обычной сборкой.

Реальная установка/повторная установка/удаление QA выполняются только отдельно
согласованным запуском `test-installer-lifecycle.ps1 -RunFixture`; тест никогда
не запускает HumbleLibrary.exe и не использует реальный профиль пользователя.
До такого запуска статические и compile-only проверки не означают, что установка,
DPI/themes или desktop pixels проверены.

Источник Mira Mint: MiraLabel `installer/` от 2026-10-17; компонентная MIT
сохранена в `installer/LICENSE` и `licenses/MiraMint-MIT.txt`. Static bootstrap
runtime notice: `licenses/bootstrap/NOTICE.md`.
