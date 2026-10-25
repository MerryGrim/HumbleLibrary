; Guided per-user installer. Five explicit payload files only; no account data.
; No application launch, elevation, network downloads, or startup registration.
#ifndef InputPath
  #error InputPath must point to a complete HumbleLibrary app image
#endif
#ifndef OutputPath
  #define OutputPath ".\output"
#endif
#ifndef AppVersion
  #error AppVersion must be provided by build-installer.ps1
#endif
#ifndef SetupVersion
  #define SetupVersion AppVersion
#endif
#ifndef OutputName
  #define OutputName "HumbleLibrary-" + SetupVersion + "-Setup-Windows-x64"
#endif
#ifdef QaFixture
  #ifndef QaTargetPath
    #error QaFixture requires an isolated QaTargetPath
  #endif
  #define ShortcutName "Humble Library Installer QA"
#else
  #define ShortcutName "Humble Library"
#endif

[Setup]
#ifdef QaFixture
AppId={{143F965D-8D2E-46BA-A48B-A9150F63C7AC}
#else
AppId={{F016A35B-FA4D-4E51-B2D6-6F8E59E6E804}
#endif
AppName=Humble Library
AppVersion={#AppVersion}
AppVerName=Humble Library {#AppVersion}
AppPublisher=Nyanma
VersionInfoVersion={#SetupVersion}
VersionInfoDescription=Humble Library Setup
VersionInfoProductName=Humble Library
VersionInfoProductVersion={#AppVersion}
#ifdef QaFixture
DefaultDirName={#QaTargetPath}
#else
DefaultDirName={localappdata}\Programs\HumbleLibrary
#endif
DefaultGroupName={#ShortcutName}
UsePreviousAppDir=yes
PrivilegesRequired=lowest
SetupArchitecture=x64
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
AllowNetworkDrive=no
AllowUNCPath=no
AllowRootDirectory=no
DisableWelcomePage=no
DisableDirPage=no
DisableProgramGroupPage=yes
DisableReadyPage=no
DisableFinishedPage=no
DisableStartupPrompt=yes
AllowCancelDuringInstall=yes
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage
UsePreviousLanguage=yes
UsePreviousTasks=no
WizardStyle=modern dynamic windows11 hidebevels
WizardImageFile=
WizardSmallImageFile=
SetupIconFile=..\source\src-tauri\icons\icon.ico
WizardSizePercent=110
WizardKeepAspectRatio=no
DefaultDialogFontName=Segoe UI
CloseApplications=no
RestartApplications=no
AlwaysRestart=no
UninstallRestartComputer=no
UninstallDisplayName={#ShortcutName}
UninstallDisplayIcon={app}\HumbleLibrary.exe
UninstallFilesDir={app}\.uninstall
OutputDir={#OutputPath}
OutputBaseFilename={#OutputName}
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
SetupLogging=no

#include "InstallerLanguages.iss"

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopTask}"; GroupDescription: "{cm:ShortcutsGroup}"; Flags: unchecked

[Files]
Source: "{#InputPath}\HumbleLibrary.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#InputPath}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#InputPath}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#InputPath}\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "installed.marker"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\{#ShortcutName}"; Filename: "{app}\HumbleLibrary.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\{#ShortcutName}"; Filename: "{app}\HumbleLibrary.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Code]
const
  GWL_STYLE = -16;
  WS_CAPTION = $00C00000;
  SWP_NOSIZE = $0001;
  SWP_NOMOVE = $0002;
  SWP_NOZORDER = $0004;
  SWP_NOACTIVATE = $0010;
  SWP_FRAMECHANGED = $0020;
  WM_NCHITTEST = $0084;
  WM_NCDESTROY = $0082;
  HTCAPTION = 2;
  WizardSubclassId = 41721;

type
  TInstallerPoint = record X, Y: Integer; end;
  TInstallerBounds = record Left, Top, Width, Height: Integer; end;

function GetWindowLongPtr(Window: HWND; Index: Integer): NativeInt;
  external 'GetWindowLongPtrW@user32.dll stdcall';
function SetWindowLongPtr(Window: HWND; Index: Integer; Value: NativeInt): NativeInt;
  external 'SetWindowLongPtrW@user32.dll stdcall';
function SetWindowPos(Window, InsertAfter: HWND; X, Y, Width, Height: Integer; Flags: Cardinal): Boolean;
  external 'SetWindowPos@user32.dll stdcall';
function ScreenToClient(Window: HWND; var Point: TInstallerPoint): Boolean;
  external 'ScreenToClient@user32.dll stdcall';
function SetWindowSubclass(Window: HWND; Callback: NativeInt; Id, RefData: NativeUInt): Boolean;
  external 'SetWindowSubclass@comctl32.dll stdcall';
function RemoveWindowSubclass(Window: HWND; Callback: NativeInt; Id: NativeUInt): Boolean;
  external 'RemoveWindowSubclass@comctl32.dll stdcall';
function DefSubclassProc(Window: HWND; Msg: Cardinal; WParam: NativeUInt; LParam: NativeInt): NativeInt;
  external 'DefSubclassProc@comctl32.dll stdcall';

var
  WindowCloseButton: TNewButton;
  WizardCallback: NativeInt;
  WizardWindow: HWND;

#include "MiraMintButtons.iss"
#include "MiraMintDialogs.iss"

function WizardWindowProc(Window: HWND; Msg: Cardinal; WParam: NativeUInt;
  LParam: NativeInt; Id, RefData: NativeUInt): NativeInt;
var
  Point: TInstallerPoint;
  InCloseButton: Boolean;
begin
  if Msg = WM_NCDESTROY then
    RemoveWindowSubclass(Window, WizardCallback, WizardSubclassId);
  if (Msg = WM_NCHITTEST) and (WindowCloseButton <> nil) then begin
    { LPARAM packs signed screen coordinates, including monitors left/above primary. }
    Point.X := LParam and $FFFF;
    Point.Y := (LParam shr 16) and $FFFF;
    if Point.X >= $8000 then Point.X := Point.X - $10000;
    if Point.Y >= $8000 then Point.Y := Point.Y - $10000;
    if ScreenToClient(Window, Point) then begin
      InCloseButton := (Point.X >= WindowCloseButton.Left) and
        (Point.X < WindowCloseButton.Left + WindowCloseButton.Width) and
        (Point.Y >= WindowCloseButton.Top) and
        (Point.Y < WindowCloseButton.Top + WindowCloseButton.Height);
      if (Point.X >= 0) and (Point.X < WizardForm.ClientWidth) and (Point.Y >= 0) and
        (Point.Y < WindowCloseButton.Top + WindowCloseButton.Height + ScaleY(4)) and not InCloseButton then begin
        Result := HTCAPTION;
        Exit;
      end;
    end;
  end;
  Result := DefSubclassProc(Window, Msg, WParam, LParam);
end;

procedure RemoveNativeCaption;
var
  Style: NativeInt;
begin
  { SetupArchitecture=x64 makes pointer-sized declarations correct for this process. }
  Style := GetWindowLongPtr(WizardForm.Handle, GWL_STYLE);
  if (Style and WS_CAPTION) <> 0 then begin
    SetWindowLongPtr(WizardForm.Handle, GWL_STYLE, Style and not WS_CAPTION);
    SetWindowPos(WizardForm.Handle, 0, 0, 0, 0, 0,
      SWP_NOSIZE or SWP_NOMOVE or SWP_NOZORDER or SWP_NOACTIVATE or SWP_FRAMECHANGED);
  end;
  MintApplyDwmCorners(WizardForm.Handle);
end;

procedure CloseWizardWindow(Sender: TObject);
begin
  { Use Inno's normal close query/cancel/rollback path, never terminate the process. }
  WizardForm.Close;
end;

procedure SyncWindowCloseButton(FinishedPage: Boolean);
var AllowClose: Boolean;
begin
  if WindowCloseButton = nil then Exit;
  AllowClose := WizardForm.CancelButton.Enabled or FinishedPage;
  if WindowCloseButton.Enabled <> AllowClose then
    WindowCloseButton.Enabled := AllowClose;
end;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
begin
  { File progress does not change captions, fonts or styles. Keep the native
    cancel/rollback gate, without repainting every button on every file. }
  SyncWindowCloseButton(False);
end;

procedure InitializeWizard;
var
  I, Padding, Count, OriginalWidth, OriginalHeight: Integer;
  OriginalBounds: array of TInstallerBounds;
begin
  { Keep native page content and Back/Next/Cancel behavior, with an empty drag strip. }
  Padding := ScaleY(32);
  Count := WizardForm.ControlCount;
  OriginalWidth := WizardForm.ClientWidth;
  OriginalHeight := WizardForm.ClientHeight;
  SetArrayLength(OriginalBounds, Count);
  for I := 0 to Count - 1 do begin
    OriginalBounds[I].Left := WizardForm.Controls[I].Left;
    OriginalBounds[I].Top := WizardForm.Controls[I].Top;
    OriginalBounds[I].Width := WizardForm.Controls[I].Width;
    OriginalBounds[I].Height := WizardForm.Controls[I].Height;
  end;
  RemoveNativeCaption;
  WizardForm.ClientWidth := OriginalWidth;
  WizardForm.ClientHeight := OriginalHeight + Padding;
  { Client resize updates anchored heights; restore complete original bounds. }
  for I := 0 to Count - 1 do
    WizardForm.Controls[I].SetBounds(OriginalBounds[I].Left,
      OriginalBounds[I].Top + Padding, OriginalBounds[I].Width, OriginalBounds[I].Height);

  WizardForm.WizardBitmapImage.Visible := False;
  WizardForm.WizardBitmapImage2.Visible := False;
  WizardForm.WizardSmallBitmapImage.Visible := False;
  WizardForm.SelectDirBitmapImage.Visible := False;
  WizardForm.SelectGroupBitmapImage.Visible := False;
  { Reclaim the text gutter left by the removed directory/group pictograms. }
  WizardForm.SelectDirLabel.Left := 0;
  WizardForm.SelectDirLabel.Width := WizardForm.InnerPage.ClientWidth;
  WizardForm.SelectDirBrowseLabel.Left := 0;
  WizardForm.SelectDirBrowseLabel.Width := WizardForm.InnerPage.ClientWidth;
  WizardForm.DirEdit.Left := 0;
  WizardForm.DirBrowseButton.Left := WizardForm.InnerPage.ClientWidth - WizardForm.DirBrowseButton.Width;
  WizardForm.DirEdit.Width := WizardForm.DirBrowseButton.Left - ScaleX(8);
  WizardForm.SelectStartMenuFolderLabel.Left := 0;
  WizardForm.SelectStartMenuFolderLabel.Width := WizardForm.InnerPage.ClientWidth;
  WizardForm.SelectStartMenuFolderBrowseLabel.Left := 0;
  WizardForm.SelectStartMenuFolderBrowseLabel.Width := WizardForm.InnerPage.ClientWidth;
  WizardForm.GroupEdit.Left := 0;
  WizardForm.GroupBrowseButton.Left := WizardForm.InnerPage.ClientWidth - WizardForm.GroupBrowseButton.Width;
  WizardForm.GroupEdit.Width := WizardForm.GroupBrowseButton.Left - ScaleX(8);
  WizardForm.WelcomeLabel1.Left := ScaleX(24);
  WizardForm.WelcomeLabel1.Width := WizardForm.WelcomePage.ClientWidth - ScaleX(48);
  WizardForm.WelcomeLabel2.Left := ScaleX(24);
  WizardForm.WelcomeLabel2.Width := WizardForm.WelcomePage.ClientWidth - ScaleX(48);
  WizardForm.WelcomeLabel2.Caption := CustomMessage('WelcomeText');
  WizardForm.FinishedHeadingLabel.Left := ScaleX(24);
  WizardForm.FinishedHeadingLabel.Width := WizardForm.FinishedPage.ClientWidth - ScaleX(48);
  WizardForm.FinishedLabel.Left := ScaleX(24);
  WizardForm.FinishedLabel.Width := WizardForm.FinishedPage.ClientWidth - ScaleX(48);
  WizardForm.FinishedLabel.Caption := CustomMessage('FinishedText');
  WizardForm.PageNameLabel.Width := WizardForm.MainPanel.ClientWidth - WizardForm.PageNameLabel.Left - ScaleX(24);
  WizardForm.PageDescriptionLabel.Width := WizardForm.PageNameLabel.Width;
  WizardForm.Hint := CustomMessage('MoveWindow');
  WizardForm.ShowHint := True;

  WindowCloseButton := TNewButton.Create(WizardForm);
  WindowCloseButton.Parent := WizardForm;
  WindowCloseButton.SetBounds(WizardForm.ClientWidth - ScaleX(40), ScaleY(2), ScaleX(32), ScaleY(28));
  WindowCloseButton.Anchors := [akTop, akRight];
  WindowCloseButton.Caption := '×';
  WindowCloseButton.OnClick := @CloseWizardWindow;
  WindowCloseButton.TabStop := True;
  WindowCloseButton.Hint := CustomMessage('CloseWindow');
  WindowCloseButton.ShowHint := True;
  MintInitializeButtons(WindowCloseButton);
  WizardForm.DirBrowseButton.OnClick := @MintBrowseFolder;
  WizardWindow := WizardForm.Handle;
  WizardCallback := CreateCallback(@WizardWindowProc);
  if not SetWindowSubclass(WizardForm.Handle, WizardCallback, WizardSubclassId, 0) then
    Log('Custom drag area could not be enabled; Alt+Space, Move remains available.');
  RemoveNativeCaption;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  RemoveNativeCaption;
  SyncWindowCloseButton(CurPageID = wpFinished);
  MintRefreshButtons;
end;

procedure DeinitializeSetup;
begin
  MintShutdownButtons;
  if (WizardWindow <> 0) and (WizardCallback <> 0) then
    RemoveWindowSubclass(WizardWindow, WizardCallback, WizardSubclassId);
end;

function HumbleOpenExistingFile(const FileName: String; Access, Share: Cardinal;
  Security: NativeInt; Creation, Flags: Cardinal; Template: NativeInt): NativeInt;
  external 'CreateFileW@kernel32.dll stdcall';
function HumbleCloseHandle(Handle: NativeInt): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

procedure HumbleMessage(const Heading, Text: String);
var Width, Height: Integer; Okay: TNewButton;
begin
  if WizardSilent then Exit;
  MintCreatePopup('Humble Library — ' + Heading, Heading, 580, 260);
  try
    Width := MintPopupNominalWidth; Height := MintPopupNominalHeight;
    MintPopupLabel(Text, 20, 60, Width - 40, Height - 120);
    Okay := MintPopupButton(SetupMessage(msgButtonOK), Width - 140, Height - 46, 120, 0, mrCancel);
    MintPopup.ActiveControl := Okay;
    MintPopup.ShowModal;
  finally
    MintFreePopup;
  end;
end;

function HumbleDestinationError: String;
var Folder: String;
begin
  Folder := AddBackslash(WizardDirValue);
  Result := '';
  if FileExists(Folder + 'portable.marker') or DirExists(Folder + 'portable.marker') then
    Result := CustomMessage('PortableDestination')
  else if FileExists(Folder + 'HumbleLibrary.exe') and not FileExists(Folder + 'installed.marker') then
    Result := CustomMessage('UnmanagedDestination');
end;

function HumbleTargetAvailable: Boolean;
var FileName: String; Handle: NativeInt;
begin
  Result := True;
  FileName := AddBackslash(WizardDirValue) + 'HumbleLibrary.exe';
  if not FileExists(FileName) then Exit;
  { OPEN_EXISTING + GENERIC_WRITE checks sharing/access without modifying bytes. }
  Handle := HumbleOpenExistingFile(FileName, $40000000, 7, 0, 3, 0, 0);
  Result := Handle <> -1;
  if Result then HumbleCloseHandle(Handle);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var ErrorText: String;
begin
  Result := True;
  if (CurPageID = wpSelectDir) or (CurPageID = wpReady) then begin
    ErrorText := HumbleDestinationError;
    if ErrorText <> '' then begin
      HumbleMessage(CustomMessage('DestinationTitle'), ErrorText);
      Result := False;
      Exit;
    end;
  end;
  if (CurPageID = wpReady) and not HumbleTargetAvailable then begin
    HumbleMessage(CustomMessage('TargetBusyTitle'), CustomMessage('TargetBusyBody'));
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := HumbleDestinationError;
  if (Result = '') and not HumbleTargetAvailable then Result := CustomMessage('TargetBusyBody');
end;

