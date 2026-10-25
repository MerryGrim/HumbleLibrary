// HumbleLibrary's small, local Win32 language bootstrap. No installer actions here.
// The embedded, unchanged Inno executable owns installation and uninstallation.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <commctrl.h>
#include <windowsx.h>
#include <objbase.h>
#include <dwmapi.h>
#include <string>
#include <vector>
#include <algorithm>
#include <fstream>

namespace {
#ifdef HL_SETUP_QA
constexpr wchar_t WindowClass[] = L"HumbleLibrary.Setup.QA.Language";
constexpr wchar_t UninstallKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{143F965D-8D2E-46BA-A48B-A9150F63C7AC}_is1";
#else
constexpr wchar_t WindowClass[] = L"HumbleLibrary.Setup.Language";
constexpr wchar_t UninstallKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{F016A35B-FA4D-4E51-B2D6-6F8E59E6E804}_is1";
#endif
constexpr wchar_t WindowTitle[] = L"Humble Library — Language";
constexpr int ContinueId = 20, CloseId = 21, FirstLanguageId = 30;
#include "InstallerLanguages.h"
HINSTANCE Instance;
HWND Window = nullptr, Buttons[LanguageCount + 2]{};
HFONT TextFont = nullptr, TitleFont = nullptr;
int Selection = 1, Hover = -1, ScaleDpi = 96;
bool Dark = false, Accepted = false, ErrorMode = false;
std::wstring ErrorText;
COLORREF Background, Surface, Ink, Border, Accent;

int Px(int value) { return MulDiv(value, ScaleDpi, 96); }
bool Starts(const std::wstring& value, const wchar_t* prefix) {
  const size_t length = wcslen(prefix);
  return value.size() >= length && _wcsnicmp(value.c_str(), prefix, length) == 0;
}
int LanguageIndex(const std::wstring& value) {
  for (int i = 0; i < LanguageCount; ++i) if (_wcsicmp(value.c_str(), LanguageCodes[i]) == 0) return i;
  return -1;
}
std::wstring QuoteArgument(const std::wstring& value) {
  // CommandLineToArgvW/MSVC-compatible quoting, including empty arguments,
  // embedded quotes and trailing backslashes. Never invoke a shell.
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (const wchar_t c : value) {
    if (c == L'\\') { ++slashes; continue; }
    if (c == L'\"') { result.append(slashes * 2 + 1, L'\\'); result += c; }
    else { result.append(slashes, L'\\'); result += c; }
    slashes = 0;
  }
  result.append(slashes * 2, L'\\'); result += L'\"';
  return result;
}
std::wstring BuildCommand(const std::wstring& executable, const std::vector<std::wstring>& arguments) {
  std::wstring command = QuoteArgument(executable);
  for (const auto& argument : arguments) { command += L' '; command += QuoteArgument(argument); }
  return command;
}
std::wstring OriginalTail(const std::wstring& command) {
  // Same quote-toggle rule as Inno Shared.CommonFunc.GetParamStr. The tail is
  // copied verbatim, not decoded and re-encoded using the different CRT rules.
  size_t position=0; bool quoted=false;
  while(position<command.size() && (command[position]>L' ' || quoted)) {
    if(command[position]==L'"') quoted=!quoted;
    ++position;
  }
  while(position<command.size() && command[position]<=L' ') ++position;
  return command.substr(position);
}
std::vector<std::wstring> InnoArguments(const std::wstring& tail) {
  std::vector<std::wstring> result; size_t position=0;
  while(position<tail.size()) {
    while(position<tail.size() && tail[position]<=L' ') ++position;
    if(position==tail.size()) break;
    bool quoted=false; std::wstring value;
    while(position<tail.size() && (tail[position]>L' ' || quoted)) {
      if(tail[position]==L'"') quoted=!quoted; else value+=tail[position];
      ++position;
    }
    result.push_back(value);
  }
  return result;
}
bool QuotingSelfTest() {
  const std::vector<std::wstring> tails={LR"(/DIR="D:\folder space\" /UNKNOWN="a b")", LR"(/A="" /X=$`&() /LANG=russian)", LR"(/MINTARGFIXTURE="D:\Тест 中文\path space\")"};
  for(const auto& tail:tails) if(OriginalTail(QuoteArgument(LR"(D:\Tools\Setup.exe)")+L" "+tail)!=tail) return false;
  const std::vector<std::wstring> samples = {L"", L"a b", L"D:\\папка 中文\\", L"a\"b", L"a\\\"b", L"plain", L"/DIR=D:\\A B\\", L"/TOKEN=$`&()"};
  std::wstring command = BuildCommand(L"fixture.exe", samples);
  int count = 0; LPWSTR* parsed = CommandLineToArgvW(command.c_str(), &count);
  bool okay = parsed && count == static_cast<int>(samples.size()) + 1;
  if (okay) for (int i = 1; i < count; ++i) if (samples[static_cast<size_t>(i - 1)] != parsed[i]) okay = false;
  if (parsed) LocalFree(parsed);
  return okay;
}
void Palette() {
  DWORD light = 1, bytes = sizeof(light);
  RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &light, &bytes);
  HIGHCONTRASTW contrast{sizeof(contrast)};
  SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(contrast), &contrast, 0);
  Dark = light == 0;
  Background = Dark ? RGB(17,25,31) : RGB(243,247,245);
  Surface = Dark ? RGB(27,37,44) : RGB(254,255,255);
  Ink = Dark ? RGB(234,242,241) : RGB(22,54,46);
  Border = Dark ? RGB(51,66,75) : RGB(223,232,228);
  Accent = Dark ? RGB(120,224,209) : RGB(22,133,109);
  if (contrast.dwFlags & HCF_HIGHCONTRASTON) {
    Background = GetSysColor(COLOR_WINDOW); Surface = GetSysColor(COLOR_BTNFACE);
    Ink = GetSysColor(COLOR_WINDOWTEXT); Border = GetSysColor(COLOR_WINDOWTEXT); Accent = GetSysColor(COLOR_HIGHLIGHT);
  }
}
void DrawTextIn(HDC dc, const wchar_t* text, RECT rect, HFONT font, COLORREF color, UINT flags) {
  HGDIOBJ previous = SelectObject(dc, font); SetBkMode(dc, TRANSPARENT); SetTextColor(dc, color);
  DrawTextW(dc, text, -1, &rect, flags); SelectObject(dc, previous);
}
void PaintButton(DRAWITEMSTRUCT* item) {
  const bool close = item->CtlID == CloseId;
  const bool primary = item->CtlID == ContinueId;
  const bool selected = item->CtlID >= FirstLanguageId && item->CtlID < FirstLanguageId + LanguageCount && Selection == static_cast<int>(item->CtlID) - FirstLanguageId;
  const bool hovered = Hover == static_cast<int>(item->CtlID);
  const bool pressed = (item->itemState & ODS_SELECTED) != 0;
  COLORREF fill = (primary || selected) ? Accent : Surface;
  if (hovered || pressed) fill = primary || selected ? (Dark ? RGB(107,208,189) : RGB(19,118,96)) : (Dark ? RGB(33,66,63) : RGB(225,243,236));
  HBRUSH background = CreateSolidBrush(Background); FillRect(item->hDC, &item->rcItem, background); DeleteObject(background);
  HBRUSH brush = CreateSolidBrush(fill); HPEN pen = CreatePen(PS_SOLID, Px(1), selected || primary ? Accent : Border);
  HGDIOBJ oldBrush = SelectObject(item->hDC, brush), oldPen = SelectObject(item->hDC, pen);
  if (!close || hovered || pressed) {
    if (close) Rectangle(item->hDC, item->rcItem.left, item->rcItem.top, item->rcItem.right, item->rcItem.bottom);
    else RoundRect(item->hDC, item->rcItem.left, item->rcItem.top, item->rcItem.right, item->rcItem.bottom, Px(12), Px(12));
  }
  if (close) {
    HPEN cross = CreatePen(PS_SOLID, Px(2), Ink); SelectObject(item->hDC, cross);
    const int x=(item->rcItem.left+item->rcItem.right)/2, y=(item->rcItem.top+item->rcItem.bottom)/2;
    MoveToEx(item->hDC,x-Px(4),y-Px(4),nullptr); LineTo(item->hDC,x+Px(4),y+Px(4));
    MoveToEx(item->hDC,x+Px(4),y-Px(4),nullptr); LineTo(item->hDC,x-Px(4),y+Px(4));
    SelectObject(item->hDC, oldPen); DeleteObject(cross);
  } else {
    wchar_t text[256]{}; GetWindowTextW(item->hwndItem, text, 256);
    DrawTextIn(item->hDC,text,item->rcItem,TextFont,(primary || selected) ? (Dark ? RGB(16,47,41) : RGB(255,255,255)) : Ink,DT_CENTER|DT_VCENTER|DT_SINGLELINE);
  }
  if (item->itemState & ODS_FOCUS) { RECT focus=item->rcItem; InflateRect(&focus,-Px(4),-Px(4)); DrawFocusRect(item->hDC,&focus); }
  SelectObject(item->hDC,oldBrush); SelectObject(item->hDC,oldPen); DeleteObject(brush); DeleteObject(pen);
}
LRESULT CALLBACK ButtonProc(HWND control, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR);
void RefreshLabels() {
  SetWindowTextW(Window,(std::wstring(L"Humble Library — ")+Titles[Selection]).c_str());
  if (Buttons[LanguageCount]) SetWindowTextW(Buttons[LanguageCount], NextTexts[Selection]);
  if (Buttons[LanguageCount + 1]) SetWindowTextW(Buttons[LanguageCount + 1], CloseTexts[Selection]);
  for (HWND button : Buttons) if(button) InvalidateRect(button,nullptr,FALSE);
  InvalidateRect(Window,nullptr,FALSE);
}
LRESULT CALLBACK WindowProc(HWND window, UINT msg, WPARAM wp, LPARAM lp) {
  switch(msg) {
    case WM_NCHITTEST: {
      POINT point{GET_X_LPARAM(lp),GET_Y_LPARAM(lp)}; ScreenToClient(window,&point);
      if(point.y>=0 && point.y<Px(48) && point.x>=0 && point.x<Px(570)) return HTCAPTION;
      return HTCLIENT;
    }
    case WM_DRAWITEM: PaintButton(reinterpret_cast<DRAWITEMSTRUCT*>(lp)); return TRUE;
    case WM_ERASEBKGND: { RECT rect; GetClientRect(window,&rect); HBRUSH b=CreateSolidBrush(Background); FillRect(reinterpret_cast<HDC>(wp),&rect,b); DeleteObject(b); return 1; }
    case WM_PAINT: {
      PAINTSTRUCT paint; HDC dc=BeginPaint(window,&paint);
      // A language change invalidates without WM_ERASEBKGND. Repaint the actual
      // dirty surface before transparent text so the previous translation clears.
      HBRUSH background=CreateSolidBrush(Background); FillRect(dc,&paint.rcPaint,background); DeleteObject(background);
      RECT title{Px(22),Px(18),Px(570),Px(54)};
      DrawTextIn(dc,ErrorMode ? L"Humble Library" : Titles[Selection],title,TitleFont,Ink,DT_LEFT|DT_SINGLELINE|DT_VCENTER);
      RECT hint{Px(22),Px(63),Px(598),Px(ErrorMode ? 265 : 105)};
      DrawTextIn(dc,ErrorMode ? ErrorText.c_str() : Hints[Selection],hint,TextFont,Ink,DT_LEFT|DT_WORDBREAK);
      EndPaint(window,&paint); return 0;
    }
    case WM_COMMAND: {
      const int id=LOWORD(wp);
      if(id>=FirstLanguageId && id<FirstLanguageId+LanguageCount) { Selection=id-FirstLanguageId; RefreshLabels(); return 0; }
      if(id==ContinueId || (id==IDOK && !ErrorMode)) { Accepted=true; DestroyWindow(window); return 0; }
      if(id==CloseId || id==IDCANCEL) { DestroyWindow(window); return 0; }
      return 0;
    }
    case WM_CLOSE: DestroyWindow(window); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(window,msg,wp,lp);
}
LRESULT CALLBACK ButtonProc(HWND control, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR id, DWORD_PTR data) {
  (void)id; (void)data;
  if(msg==WM_MOUSEMOVE) { Hover=GetDlgCtrlID(control); TRACKMOUSEEVENT track{sizeof(track),TME_LEAVE,control,0}; TrackMouseEvent(&track); InvalidateRect(control,nullptr,FALSE); }
  if(msg==WM_MOUSELEAVE) { Hover=-1; InvalidateRect(control,nullptr,FALSE); }
  if(msg==WM_KEYDOWN && wp==VK_ESCAPE) { SendMessageW(Window,WM_CLOSE,0,0); return 0; }
  if(msg==WM_KEYDOWN && wp==VK_RETURN) { SendMessageW(Window,WM_COMMAND,ContinueId,0); return 0; }
  return DefSubclassProc(control,msg,wp,lp);
}
bool ShowLanguage(bool error=false) {
  ErrorMode=error; Accepted=false; Hover=-1; Palette();
  WNDCLASSEXW cls{sizeof(cls)}; cls.lpfnWndProc=WindowProc; cls.hInstance=Instance; cls.hCursor=LoadCursor(nullptr,IDC_ARROW); cls.lpszClassName=WindowClass;
  cls.hIcon=LoadIconW(Instance,MAKEINTRESOURCEW(1)); RegisterClassExW(&cls);
  ScaleDpi=static_cast<int>(GetDpiForSystem());
  const int width=Px(620),height=Px(346);
  Window=CreateWindowExW(WS_EX_CONTROLPARENT,WindowClass,WindowTitle,WS_POPUP|WS_CLIPCHILDREN,
    (GetSystemMetrics(SM_CXSCREEN)-width)/2,(GetSystemMetrics(SM_CYSCREEN)-height)/2,width,height,nullptr,nullptr,Instance,nullptr);
  if(!Window) return false;
  TextFont=CreateFontW(-Px(14),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Segoe UI");
  TitleFont=CreateFontW(-Px(20),0,0,0,FW_SEMIBOLD,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Segoe UI");
  // DWM owns the antialiased silhouette. HRGN/per-pixel alpha would disable it.
  SetWindowRgn(Window,nullptr,FALSE);
  const DWM_WINDOW_CORNER_PREFERENCE preference=DWMWCP_ROUND;
  const BOOL dark=Dark;
  const HRESULT cornerResult=DwmSetWindowAttribute(Window,DWMWA_WINDOW_CORNER_PREFERENCE,&preference,sizeof(preference));
  DwmSetWindowAttribute(Window,DWMWA_USE_IMMERSIVE_DARK_MODE,&dark,sizeof(dark));
  DwmSetWindowAttribute(Window,DWMWA_BORDER_COLOR,&Border,sizeof(Border));
  if(FAILED(cornerResult)) OutputDebugStringW(L"HumbleLibrary: DWM corner preference unavailable; rectangular compositor fallback.\n");
  for(int i=0;i<LanguageCount+2;++i) {
    if(error && i<LanguageCount+1) continue;
    const bool language = i<LanguageCount;
    const int x=language?22+(i%3)*196:(i==LanguageCount?430:578);
    const int y=language?111+(i/3)*49:(i==LanguageCount?294:8);
    const int w=language?184:(i==LanguageCount?168:32), h=i==LanguageCount+1?30:36;
    const int id=language?FirstLanguageId+i:(i==LanguageCount?ContinueId:CloseId);
    Buttons[i]=CreateWindowExW(0,L"BUTTON",language?LanguageNames[i]:(i==LanguageCount?NextTexts[Selection]:CloseTexts[Selection]),WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,
      Px(x),Px(y),Px(w),Px(h),Window,reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),Instance,nullptr);
    SendMessageW(Buttons[i],WM_SETFONT,reinterpret_cast<WPARAM>(TextFont),FALSE);
    SetWindowSubclass(Buttons[i],ButtonProc,1,0);
  }
  RefreshLabels();
  ShowWindow(Window,SW_SHOWNORMAL); UpdateWindow(Window); SetFocus(Buttons[error?LanguageCount+1:Selection]);
  MSG message; while(GetMessageW(&message,nullptr,0,0)>0) { if(!IsDialogMessageW(Window,&message)) { TranslateMessage(&message); DispatchMessageW(&message); } }
  for(auto& button:Buttons) button=nullptr;
  DeleteObject(TextFont); DeleteObject(TitleFont); TextFont=nullptr; TitleFont=nullptr; Window=nullptr;
  return Accepted;
}
int DefaultLanguage() {
  wchar_t previous[80]{}; DWORD bytes=sizeof(previous);
  if(RegGetValueW(HKEY_CURRENT_USER,UninstallKey,L"Inno Setup: Language",RRF_RT_REG_SZ|RRF_SUBKEY_WOW6464KEY,nullptr,previous,&bytes)==ERROR_SUCCESS) {
    const int index=LanguageIndex(previous); if(index>=0) return index;
  }
  const LANGID language=PRIMARYLANGID(GetUserDefaultUILanguage());
  switch(language) { case LANG_RUSSIAN:return 0; case LANG_GERMAN:return 2; case LANG_ITALIAN:return 3; case LANG_SPANISH:return 4; case LANG_FRENCH:return 5; case LANG_CHINESE:return 6; case LANG_JAPANESE:return 7; case LANG_KOREAN:return 8; default:return 1; }
}
bool WriteBytes(const std::wstring& path, const void* data, DWORD bytes) {
  HANDLE file=CreateFileW(path.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_TEMPORARY,nullptr);
  if(file==INVALID_HANDLE_VALUE) return false;
  DWORD written=0; const bool okay=WriteFile(file,data,bytes,&written,nullptr) && written==bytes;
  FlushFileBuffers(file); CloseHandle(file); return okay;
}
void Error(int index, bool silent) {
  ErrorText=ErrorMessages[index][Selection]; if(!silent) ShowLanguage(true);
}
}

int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,LPWSTR,int) {
  Instance=instance; SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  INITCOMMONCONTROLSEX controls{sizeof(controls),ICC_STANDARD_CLASSES}; InitCommonControlsEx(&controls);
  if(!QuotingSelfTest()) return 3;
  const std::wstring originalTail=OriginalTail(GetCommandLineW());
  const std::vector<std::wstring> arguments=InnoArguments(originalTail); bool silent=false; int explicitLanguage=-1; std::wstring loadInf;
  for(const auto& argument : arguments) {
    if(_wcsicmp(argument.c_str(),L"/SILENT")==0 || _wcsicmp(argument.c_str(),L"/VERYSILENT")==0) silent=true;
    if(Starts(argument,L"/LANG=")) explicitLanguage=LanguageIndex(argument.substr(6));
    if(Starts(argument,L"/LOADINF=")) loadInf=argument.substr(9);
    if(Starts(argument,L"/SL5=") || Starts(argument,L"/DEBUGWND=") || Starts(argument,L"/SPAWNWND=") || Starts(argument,L"/NOTIFYWND=")) { return 3; }
  }
  if(!loadInf.empty()) { wchar_t fullInf[32768]{}; if(GetFullPathNameW(loadInf.c_str(),32768,fullInf,nullptr)) loadInf=fullInf; wchar_t language[80]{}; GetPrivateProfileStringW(L"Setup",L"Lang",L"",language,80,loadInf.c_str()); const int index=LanguageIndex(language); if(index>=0) explicitLanguage=index; }
  Selection=explicitLanguage>=0?explicitLanguage:DefaultLanguage();
  if(!silent && explicitLanguage<0 && !ShowLanguage()) return 2;
  std::wstring forwardedTail=originalTail;
  if(!silent || explicitLanguage>=0) forwardedTail+=std::wstring(L" /LANG=")+LanguageCodes[Selection];
  HRSRC resource=FindResourceW(instance,MAKEINTRESOURCEW(101),RT_RCDATA); HGLOBAL loaded=resource?LoadResource(instance,resource):nullptr;
  const void* data=loaded?LockResource(loaded):nullptr; const DWORD bytes=resource?SizeofResource(instance,resource):0;
  if(!data || !bytes) { Error(0,silent); return 3; }
  wchar_t temporary[MAX_PATH]{}; if(!GetTempPathW(MAX_PATH,temporary)) return 3;
  GUID guid; if(FAILED(CoCreateGuid(&guid))) return 3; wchar_t suffix[50]{}; StringFromGUID2(guid,suffix,50);
  const std::wstring directory=std::wstring(temporary)+L"HumbleLibrary-Setup-"+suffix;
  if(!CreateDirectoryW(directory.c_str(),nullptr)) { Error(1,silent); return 3; }
  const std::wstring inner=directory+L"\\HumbleLibrary.Inner.exe";
  if(!WriteBytes(inner,data,bytes)) { DeleteFileW(inner.c_str()); RemoveDirectoryW(directory.c_str()); Error(2,silent); return 3; }
  std::wstring command=QuoteArgument(inner)+L" "+forwardedTail; STARTUPINFOW startup{sizeof(startup)}; PROCESS_INFORMATION process{};
  const BOOL started=CreateProcessW(inner.c_str(),command.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&startup,&process);
  DWORD exitCode=3;
  if(started) { CloseHandle(process.hThread); WaitForSingleObject(process.hProcess,INFINITE); GetExitCodeProcess(process.hProcess,&exitCode); CloseHandle(process.hProcess); }
  // Exact known file in the directory we just created; never recurse or delete others.
  DeleteFileW(inner.c_str()); RemoveDirectoryW(directory.c_str());
  if(!started) Error(3,silent);
  return static_cast<int>(exitCode);
}
