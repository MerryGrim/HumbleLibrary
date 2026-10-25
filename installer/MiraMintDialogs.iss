{ All ordinary subordinate Setup windows are ours; no shell folder or MsgBox UI. }
const
  MintPopupSubclassId = 41724;
  MintTreeSetBackground = $111D;
  MintTreeSetText = $111E;

type
  TMintMonitorInfo = record Size: Cardinal; Monitor, Work: TMintRect; Flags: Cardinal; end;

function MintMonitorFromWindow(Window: HWND; Flags: Cardinal): NativeUInt;
  external 'MonitorFromWindow@user32.dll stdcall';
function MintGetMonitorInfo(Monitor: NativeUInt; var Info: TMintMonitorInfo): Boolean;
  external 'GetMonitorInfoW@user32.dll stdcall';

function MintDriveType(const Root: String): Cardinal;
  external 'GetDriveTypeW@kernel32.dll stdcall';

function MintSetWindowRegion(Window: HWND; Region: NativeUInt; Redraw: Boolean): Integer;
  external 'SetWindowRgn@user32.dll stdcall';

var
  MintPopup: TSetupForm;
  MintPopupX: TNewButton;
  MintPopupCallback: NativeInt;
  MintPopupWindow: HWND;
  MintFolderTree: TFolderTreeView;
  MintFolderEdit: TNewEdit;
  MintFolderError: TNewStaticText;
  MintFolderAccept: TNewButton;
  MintFolderResult: String;
  MintFolderWasAccepted: Boolean;
  MintPopupProofActive: Boolean;
  MintPopupNominalWidth, MintPopupNominalHeight: Integer;

function MintDwmAttribute(Window: HWND; Attribute: Cardinal; var Value: Cardinal; Bytes: Cardinal): Integer;
  external 'DwmSetWindowAttribute@dwmapi.dll stdcall';

procedure MintApplyDwmCorners(Window: HWND);
var Preference, Dark, BorderColor: Cardinal; Status: Integer;
begin
  { A window region excludes compositor rounding, even if the hint returns S_OK. }
  MintSetWindowRegion(Window, 0, False);
  Preference := 2;
  Status := MintDwmAttribute(Window, 33, Preference, SizeOf(Preference));
  Dark := Ord(IsDarkInstallMode);
  MintDwmAttribute(Window, 20, Dark, SizeOf(Dark));
  BorderColor := MintPalette($00E4E8DF, $004B4233);
  MintDwmAttribute(Window, 34, BorderColor, SizeOf(BorderColor));
  Log('DWM corner preference result=' + IntToStr(Status) + '; no HRGN; visual rounding requires compositor QA.');
end;

function MintPopupWindowProc(Window: HWND; Msg: Cardinal; WParam: NativeUInt;
  LParam: NativeInt; Id, RefData: NativeUInt): NativeInt;
var Point: TInstallerPoint;
begin
  if Msg = WM_NCDESTROY then begin
    RemoveWindowSubclass(Window, MintPopupCallback, MintPopupSubclassId);
    Result := DefSubclassProc(Window, Msg, WParam, LParam);
    Exit;
  end;
  if (Msg = WM_NCHITTEST) and (MintPopup <> nil) and (MintPopupX <> nil) then begin
    Point.X := LParam and $FFFF;
    Point.Y := (LParam shr 16) and $FFFF;
    if Point.X >= $8000 then Point.X := Point.X - $10000;
    if Point.Y >= $8000 then Point.Y := Point.Y - $10000;
    if ScreenToClient(Window, Point) and (Point.Y >= 0) and (Point.Y < ScaleY(38)) and
      (Point.X >= 0) and (Point.X < MintPopupX.Left - ScaleX(4)) then begin
      Result := HTCAPTION;
      Exit;
    end;
  end;
  Result := DefSubclassProc(Window, Msg, WParam, LParam);
end;

procedure MintPopupClose(Sender: TObject);
begin
  if MintPopup <> nil then MintPopup.Close;
end;

procedure MintPopupKey(Sender: TObject; var Key: Word; Shift: TShiftState);
begin
  if Key = 27 then begin Key := 0; MintPopupClose(Sender); end;
end;

procedure MintPopupShown(Sender: TObject);
begin
  MintApplyDwmCorners(MintPopup.Handle);
  MintRefreshButtons;
end;

function MintPopupLabel(const Text: String; Left, Top, Width, Height: Integer): TNewStaticText;
begin
  Result := TNewStaticText.Create(MintPopup);
  Result.Parent := MintPopup;
  Result.SetBounds(ScaleX(Left), ScaleY(Top), ScaleX(Width), ScaleY(Height));
  Result.AutoSize := False;
  Result.WordWrap := True;
  Result.Caption := Text;
  Result.StyleElements := [];
  Result.Color := MintPopup.Color;
  Result.Font.Color := MintPalette($002E3616, $00F1F2EA);
end;

function MintPopupButton(const Text: String; Left, Top, Width, Role, Modal: Integer): TNewButton;
begin
  Result := TNewButton.Create(MintPopup);
  Result.Parent := MintPopup;
  Result.SetBounds(ScaleX(Left), ScaleY(Top), ScaleX(Width), ScaleY(30));
  Result.Caption := Text;
  Result.ModalResult := Modal;
  Result.Default := Role = 0;
  Result.Cancel := Modal = mrCancel;
  MintRegisterButton(Result, Role);
end;

procedure MintCreatePopup(const Caption, Heading: String; Width, Height: Integer);
var HeadingLabel: TNewStaticText; Info: TMintMonitorInfo; MaxWidth, MaxHeight, OverrideLimit: Integer;
begin
  Info.Size := SizeOf(Info);
  if MintGetMonitorInfo(MintMonitorFromWindow(WizardForm.Handle, 2), Info) then begin
    MaxWidth := Info.Work.Right - Info.Work.Left;
    MaxHeight := Info.Work.Bottom - Info.Work.Top;
    { Optional mock layout fixture, no display settings are changed. }
    OverrideLimit := StrToIntDef(ExpandConstant('{param:MINTDIALOGMAXWIDTH|0}'), 0);
    if (OverrideLimit > 0) and (OverrideLimit < MaxWidth) then MaxWidth := OverrideLimit;
    OverrideLimit := StrToIntDef(ExpandConstant('{param:MINTDIALOGMAXHEIGHT|0}'), 0);
    if (OverrideLimit > 0) and (OverrideLimit < MaxHeight) then MaxHeight := OverrideLimit;
    MaxWidth := (MaxWidth - ScaleX(24)) * 1000 div ScaleX(1000);
    MaxHeight := (MaxHeight - ScaleY(24)) * 1000 div ScaleY(1000);
    if Width > MaxWidth then Width := MaxWidth;
    if Height > MaxHeight then Height := MaxHeight;
  end;
  MintPopupNominalWidth := Width;
  MintPopupNominalHeight := Height;
  MintPopup := CreateCustomForm(Width, Height, False, False);
  MintPopup.Caption := Caption;
  MintPopup.BorderStyle := bsNone;
  MintPopup.BorderIcons := [];
  { InitializeFont has already resized the constructor dimensions. Restore one
    coherent ScaleX/Y coordinate system for the frame AND its child controls. }
  MintPopup.SetBounds(MintPopup.Left, MintPopup.Top, ScaleX(Width), ScaleY(Height));
  MintPopup.StyleElements := [];
  MintPopup.Color := MintPalette($00F5F7F3, $001F1911);
  MintPopup.Font.Name := 'Segoe UI';
  MintPopup.Font.Color := MintPalette($002E3616, $00F1F2EA);
  MintPopup.Position := poMainFormCenter;
  MintPopup.PopupMode := pmExplicit;
  MintPopup.PopupParent := WizardForm;
  MintPopup.KeyPreview := True;
  MintPopup.OnKeyDown := @MintPopupKey;
  HeadingLabel := MintPopupLabel(Heading, 20, 16, Width - 76, 30);
  HeadingLabel.Font.Size := 12;
  HeadingLabel.Font.Style := [fsBold];
  MintPopupX := MintPopupButton('×', Width - 43, 7, 32, 2, 0);
  MintPopupX.OnClick := @MintPopupClose;
  MintPopupX.Hint := CustomMessage('CloseWindow');
  MintPopupX.ShowHint := True;
  MintPopupX.Cancel := False;
  MintPopupWindow := MintPopup.Handle;
  if MintPopupCallback = 0 then MintPopupCallback := CreateCallback(@MintPopupWindowProc);
  SetWindowSubclass(MintPopupWindow, MintPopupCallback, MintPopupSubclassId, 0);
  MintPopup.OnShow := @MintPopupShown;
end;

procedure MintFreePopup;
begin
  { Unhook before destroying controls or their Pascal Script callback state. }
  if MintPopupWindow <> 0 then begin
    RemoveWindowSubclass(MintPopupWindow, MintPopupCallback, MintPopupSubclassId);
    MintUnregisterParent(MintPopupWindow);
  end;
  MintPopupWindow := 0;
  MintPopupX := nil;
  MintFolderTree := nil;
  MintFolderEdit := nil;
  MintFolderError := nil;
  MintFolderAccept := nil;
  if MintPopup <> nil then MintPopup.Free;
  MintPopup := nil;
end;

function MintLocalFolderCandidate(const Value: String): Boolean;
var Canonical: String;
begin
  Result := False;
  Canonical := Trim(Value);
  if (Length(Canonical) < 4) or (Copy(Canonical, 2, 2) <> ':\') then Exit;
  if (Pos('"', Canonical) > 0) or (Pos('*', Canonical) > 0) or (Pos('?', Canonical) > 0) or
    (Pos('<', Canonical) > 0) or (Pos('>', Canonical) > 0) or (Pos('|', Canonical) > 0) then Exit;
  Canonical := RemoveBackslashUnlessRoot(ExpandFileName(Canonical));
  Result := (Length(Canonical) > 3) and (MintDriveType(Copy(Canonical, 1, 3)) <> 4);
end;

procedure MintFolderChanged(Sender: TObject);
begin
  if MintFolderEdit <> nil then begin
    MintFolderEdit.Text := MintFolderTree.Directory;
    MintFolderError.Caption := '';
  end;
end;

procedure MintFolderRenamed(Sender: TCustomFolderTreeView; var NewName: String; var Accept: Boolean);
begin
  Accept := False; { Folder selection never renames or creates filesystem entries. }
end;

procedure MintFolderConfirmed(Sender: TObject);
begin
  if not MintLocalFolderCandidate(MintFolderEdit.Text) then begin
    MintFolderError.Caption := CustomMessage('FolderInvalid');
    MintFolderAccept.ModalResult := 0;
    Exit;
  end;
  MintFolderResult := RemoveBackslashUnlessRoot(ExpandFileName(Trim(MintFolderEdit.Text)));
  MintFolderWasAccepted := True;
  MintPopup.Close; { Explicit accepted state, no delayed Button.ModalResult assignment. }
end;

function MintChooseFolder(const Initial, ProofSuffix: String; var Selected: String): Boolean;
var CancelButton: TNewButton; Width, Height, TreeHeight: Integer;
begin
  Result := False;
  Selected := Initial;
  MintFolderResult := Initial;
  MintFolderWasAccepted := False;
  MintCreatePopup('Humble Library — ' + CustomMessage('FolderTitle') + ProofSuffix, CustomMessage('FolderTitle'), 510, 420);
  try
    Width := MintPopupNominalWidth; Height := MintPopupNominalHeight;
    MintPopupLabel(CustomMessage('FolderHint'), 20, 55, Width - 40, 35);
    MintFolderEdit := TNewEdit.Create(MintPopup);
    MintFolderEdit.Parent := MintPopup;
    MintFolderEdit.SetBounds(ScaleX(20), ScaleY(94), ScaleX(Width - 40), ScaleY(26));
    MintFolderEdit.StyleElements := [];
    MintFolderEdit.Color := MintPalette($00FFFFFE, $002C251B);
    MintFolderEdit.Font.Color := MintPalette($002E3616, $00F1F2EA);
    MintFolderEdit.Text := Initial;
    MintFolderTree := TFolderTreeView.Create(MintPopup);
    MintFolderTree.Parent := MintPopup;
    TreeHeight := Height - 225;
    if TreeHeight < 70 then TreeHeight := 0;
    MintFolderTree.SetBounds(ScaleX(20), ScaleY(132), ScaleX(Width - 40), ScaleY(TreeHeight));
    MintFolderTree.Visible := TreeHeight > 0;
    { Keep Inno 7's dark-aware tree style hook: it owns selection text and scrollbars. }
    MintFolderTree.ChangeDirectory(Initial, True);
    MintFolderTree.OnChange := @MintFolderChanged;
    MintFolderTree.OnRename := @MintFolderRenamed;
    MintFolderError := MintPopupLabel('', 20, Height - 85, Width - 40, 30);
    MintFolderError.Font.Color := MintPalette($004040B0, $009EAFEE);
    CancelButton := MintPopupButton(SetupMessage(msgButtonCancel), Width - 270, Height - 46, 120, 1, mrCancel);
    MintFolderAccept := MintPopupButton(CustomMessage('FolderChoose'), Width - 140, Height - 46, 120, 0, 0);
    MintFolderAccept.OnClick := @MintFolderConfirmed;
    MintPopup.ActiveControl := MintFolderEdit;
    MintPopup.ShowModal;
    Result := MintFolderWasAccepted;
    if Result then Selected := MintFolderResult;
  finally
    MintFreePopup;
  end;
end;

procedure MintBrowseFolder(Sender: TObject);
var Selected: String;
begin
  if MintChooseFolder(WizardForm.DirEdit.Text, '', Selected) then WizardForm.DirEdit.Text := Selected;
end;

function MintConfirmCancellation(const ProofSuffix: String): Boolean;
var KeepButton, ExitButton: TNewButton; Width, Height: Integer;
begin
  MintCreatePopup('Humble Library — ' + CustomMessage('CancelTitle') + ProofSuffix, CustomMessage('CancelTitle'), 450, 220);
  try
    Width := MintPopupNominalWidth; Height := MintPopupNominalHeight;
    MintPopupLabel(CustomMessage('CancelBody'), 20, 65, Width - 40, Height - 120);
    ExitButton := MintPopupButton(CustomMessage('CancelExit'), 20, Height - 46, (Width - 50) div 2, 1, mrYes);
    KeepButton := MintPopupButton(CustomMessage('CancelKeep'), 30 + (Width - 50) div 2, Height - 46, (Width - 50) div 2, 0, mrCancel);
    MintPopup.ActiveControl := KeepButton;
    Result := MintPopup.ShowModal = mrYes;
  finally
    MintFreePopup;
  end;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if Confirm and not WizardSilent then Cancel := MintConfirmCancellation('');
  Confirm := False; { Inno still owns abort/rollback; no built-in confirmation box. }
end;

