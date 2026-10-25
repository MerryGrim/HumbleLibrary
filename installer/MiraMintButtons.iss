{ Native owner-draw of the existing Inno controls. No proxy click handlers. }
const
  MintOwnerDraw = $000B;
  MintButtonTypeBits = $000F;
  MintDrawItemMessage = $002B;
  MintGetDialogCode = $0087;
  MintSetStyle = $00F4;
  MintMouseMove = $0200;
  MintMouseLeave = $02A3;
  MintGetFont = $0031;
  MintControlSubclassId = 41722;
  MintParentSubclassId = 41723;
  MintStateSelected = $0001;
  MintStateDisabled = $0004;
  MintStateFocus = $0010;
  MintStateNoAccel = $0100;
  MintDefaultDialogCode = $0010;
  MintUndefaultDialogCode = $0020;

type
  TMintRect = record Left, Top, Right, Bottom: Integer; end;
  { DRAWITEMSTRUCT: explicit x64 padding after the five UINT fields. }
  TMintDrawItem = record
    ControlType, ControlId, ItemId, ItemAction, ItemState, Padding: Cardinal;
    Window, DC: NativeUInt;
    Rect: TMintRect;
    ItemData: NativeUInt;
  end;
  TMintMouseTracking = record
    Bytes, Flags: Cardinal;
    Window: HWND;
    HoverTime, Padding: Cardinal;
  end;

procedure MintReadDrawItem(var Item: TMintDrawItem; Source: NativeInt; Bytes: NativeUInt);
  external 'RtlMoveMemory@kernel32.dll stdcall';
function MintCreateSolidBrush(Color: Cardinal): NativeUInt;
  external 'CreateSolidBrush@gdi32.dll stdcall';
function MintCreatePen(Style, Width: Integer; Color: Cardinal): NativeUInt;
  external 'CreatePen@gdi32.dll stdcall';
function MintSelectObject(DC, ObjectHandle: NativeUInt): NativeUInt;
  external 'SelectObject@gdi32.dll stdcall';
function MintDeleteObject(ObjectHandle: NativeUInt): Boolean;
  external 'DeleteObject@gdi32.dll stdcall';
function MintFillRect(DC: NativeUInt; var Rect: TMintRect; Brush: NativeUInt): Integer;
  external 'FillRect@user32.dll stdcall';
function MintRoundRect(DC: NativeUInt; Left, Top, Right, Bottom, EllipseWidth, EllipseHeight: Integer): Boolean;
  external 'RoundRect@gdi32.dll stdcall';
function MintRectangle(DC: NativeUInt; Left, Top, Right, Bottom: Integer): Boolean;
  external 'Rectangle@gdi32.dll stdcall';
function MintMoveTo(DC: NativeUInt; X, Y: Integer; Previous: NativeInt): Boolean;
  external 'MoveToEx@gdi32.dll stdcall';
function MintLineTo(DC: NativeUInt; X, Y: Integer): Boolean;
  external 'LineTo@gdi32.dll stdcall';
function MintSetTextColor(DC: NativeUInt; Color: Cardinal): Cardinal;
  external 'SetTextColor@gdi32.dll stdcall';
function MintSetBackgroundMode(DC: NativeUInt; Mode: Integer): Integer;
  external 'SetBkMode@gdi32.dll stdcall';
function MintDrawText(DC: NativeUInt; Text: String; Count: Integer; var Rect: TMintRect; Flags: Cardinal): Integer;
  external 'DrawTextW@user32.dll stdcall';
function MintSaveDC(DC: NativeUInt): Integer;
  external 'SaveDC@gdi32.dll stdcall';
function MintRestoreDC(DC: NativeUInt; Saved: Integer): Boolean;
  external 'RestoreDC@gdi32.dll stdcall';
function MintDrawFocusRect(DC: NativeUInt; var Rect: TMintRect): Boolean;
  external 'DrawFocusRect@user32.dll stdcall';
function MintInvalidate(Window: HWND; Rect: NativeInt; Erase: Boolean): Boolean;
  external 'InvalidateRect@user32.dll stdcall';
function MintTrackMouse(var Tracking: TMintMouseTracking): Boolean;
  external 'TrackMouseEvent@user32.dll stdcall';
function MintGetParent(Window: HWND): HWND;
  external 'GetParent@user32.dll stdcall';
function MintSendMessage(Window: HWND; Msg: Cardinal; WParam: NativeUInt; LParam: NativeInt): NativeInt;
  external 'SendMessageW@user32.dll stdcall';
function MintAcquireDC(Window: HWND): NativeUInt;
  external 'GetDC@user32.dll stdcall';
function MintReleaseDC(Window: HWND; DC: NativeUInt): Integer;
  external 'ReleaseDC@user32.dll stdcall';
function MintCompatibleDC(DC: NativeUInt): NativeUInt;
  external 'CreateCompatibleDC@gdi32.dll stdcall';
function MintCompatibleBitmap(DC: NativeUInt; Width, Height: Integer): NativeUInt;
  external 'CreateCompatibleBitmap@gdi32.dll stdcall';
function MintDeleteDC(DC: NativeUInt): Boolean;
  external 'DeleteDC@gdi32.dll stdcall';
function MintGetObjectType(ObjectHandle: NativeUInt): Cardinal;
  external 'GetObjectType@gdi32.dll stdcall';
function MintPixel(DC: NativeUInt; X, Y: Integer): Cardinal;
  external 'GetPixel@gdi32.dll stdcall';
function MintSystemColor(Index: Integer): Cardinal;
  external 'GetSysColor@user32.dll stdcall';
function MintParentBackground(Window: HWND; DC: NativeUInt; var Rect: TMintRect): Integer;
  external 'DrawThemeParentBackground@uxtheme.dll stdcall';
function MintStretchBlt(Dest: NativeUInt; X, Y, Width, Height: Integer;
  Source: NativeUInt; SourceX, SourceY, SourceWidth, SourceHeight: Integer; Operation: Cardinal): Boolean;
  external 'StretchBlt@gdi32.dll stdcall';

var
  MintButtons: array of TNewButton;
  MintWindows, MintParents: array of HWND;
  MintFonts: array of NativeUInt;
  MintCaptions: array of String;
  MintDefaults: array of Boolean;
  MintRoles: array of Integer;
  MintCachedEnabled: array of Boolean;
  MintBackgroundDCs, MintBackgroundBitmaps, MintBackgroundOldBitmaps: array of NativeUInt;
  MintBackgroundWidths, MintBackgroundHeights, MintBackgroundStatus: array of Integer;
  MintBackgroundLefts, MintBackgroundTops, MintBackgroundParentWidths, MintBackgroundParentHeights: array of Integer;
  MintBackgroundColors: array of Cardinal;
  MintPreparingBackground: Boolean;
#ifdef MintProgressProofInclude
  MintClosePaintCount, MintRefreshPassCount, MintRefreshInvalidationCount: Integer;
#endif
  MintInitialized: Boolean;
  MintStopping, MintProofDrawing: Boolean;
  MintButtonCallback, MintParentCallback: NativeInt;
  MintHoveredWindow: HWND;
  MintEnabled: Boolean;

function MintPalette(Light, Dark: Cardinal): Cardinal;
begin
  if IsDarkInstallMode then Result := Dark else Result := Light;
end;

function MintButtonIndex(Window: HWND): Integer;
var I: Integer;
begin
  Result := -1;
  for I := 0 to GetArrayLength(MintButtons) - 1 do
    if MintWindows[I] = Window then begin
      Result := I;
      Exit;
    end;
end;

procedure MintFreeButtonBackground(Index: Integer);
begin
  if MintBackgroundDCs[Index] <> 0 then begin
    if MintBackgroundOldBitmaps[Index] <> 0 then
      MintSelectObject(MintBackgroundDCs[Index], MintBackgroundOldBitmaps[Index]);
    MintDeleteDC(MintBackgroundDCs[Index]);
  end;
  if MintBackgroundBitmaps[Index] <> 0 then MintDeleteObject(MintBackgroundBitmaps[Index]);
  MintBackgroundDCs[Index] := 0;
  MintBackgroundBitmaps[Index] := 0;
  MintBackgroundOldBitmaps[Index] := 0;
end;

procedure MintCacheButtonBackground(Index, Width, Height: Integer);
var ReferenceDC, Brush: NativeUInt; Rect: TMintRect; Saved: Integer; Color: Cardinal;
begin
  MintFreeButtonBackground(Index);
  MintBackgroundWidths[Index] := Width;
  MintBackgroundHeights[Index] := Height;
  MintBackgroundLefts[Index] := MintButtons[Index].Left;
  MintBackgroundTops[Index] := MintButtons[Index].Top;
  MintBackgroundParentWidths[Index] := MintButtons[Index].Parent.Width;
  MintBackgroundParentHeights[Index] := MintButtons[Index].Parent.Height;
  Color := MintPalette($00F5F7F3, $001F1911);
  if MintParents[Index] = WizardForm.Handle then Color := WizardForm.Color;
  if (Color and $FF000000) = $80000000 then Color := MintSystemColor(Color and $FF);
  MintBackgroundColors[Index] := Color;
  MintBackgroundStatus[Index] := -1;
  if (Width <= 0) or (Height <= 0) or MintPreparingBackground then Exit;
  ReferenceDC := MintAcquireDC(MintParents[Index]);
  if ReferenceDC = 0 then Exit;
  try
    MintBackgroundDCs[Index] := MintCompatibleDC(ReferenceDC);
    MintBackgroundBitmaps[Index] := MintCompatibleBitmap(ReferenceDC, Width, Height);
  finally
    MintReleaseDC(MintParents[Index], ReferenceDC);
  end;
  if (MintBackgroundDCs[Index] = 0) or (MintBackgroundBitmaps[Index] = 0) then begin
    MintFreeButtonBackground(Index);
    Exit;
  end;
  MintBackgroundOldBitmaps[Index] := MintSelectObject(MintBackgroundDCs[Index], MintBackgroundBitmaps[Index]);
  Rect.Left := 0; Rect.Top := 0; Rect.Right := Width; Rect.Bottom := Height;
  Brush := MintCreateSolidBrush(Color);
  MintFillRect(MintBackgroundDCs[Index], Rect, Brush);
  MintDeleteObject(Brush);
  Saved := MintSaveDC(MintBackgroundDCs[Index]);
  MintPreparingBackground := True;
  try
    { Only our own Win32 memory DC crosses this themed-parent callback. Never
      lend Item.DC or a TCanvas-owned DC to VCL while a button is being painted. }
    MintBackgroundStatus[Index] := MintParentBackground(MintWindows[Index], MintBackgroundDCs[Index], Rect);
  finally
    MintPreparingBackground := False;
    if Saved <> 0 then MintRestoreDC(MintBackgroundDCs[Index], Saved);
  end;
  if MintGetObjectType(MintBackgroundDCs[Index]) <> 10 then MintFreeButtonBackground(Index);
end;

function MintPaintButton(var Item: TMintDrawItem): Boolean;
var
  Index, Saved, CenterX, CenterY, Radius: Integer;
  Disabled, Pressed, Hovered, Focused, Primary, CloseControl: Boolean;
  FillColor, BorderColor, TextColor, Flags: Cardinal;
  FillBrush, BorderPen, CrossPen, ParentBrush, Font: NativeUInt;
  TextRect, FocusRect: TMintRect;
begin
  Index := MintButtonIndex(Item.Window);
  Result := (Index >= 0) and (Item.ControlType = 4);
  if MintPreparingBackground then Result := False;
  if not Result then Exit;
  Disabled := (Item.ItemState and MintStateDisabled) <> 0;
  Pressed := (Item.ItemState and MintStateSelected) <> 0;
  Hovered := (MintHoveredWindow = Item.Window) and not Disabled;
  Focused := (Item.ItemState and MintStateFocus) <> 0;
  Primary := MintRoles[Index] = 0;
  CloseControl := MintRoles[Index] = 2;
#ifdef MintProgressProofInclude
  if CloseControl then MintClosePaintCount := MintClosePaintCount + 1;
#endif
  TextColor := MintPalette($002E3616, $00F1F2EA);
  BorderColor := MintPalette($00E4E8DF, $004B4233);
  FillColor := MintPalette($00FFFFFE, $002C251B);
  if Primary then begin
    FillColor := MintPalette($006D8516, $00D1E078);
    TextColor := MintPalette($00FFFFFF, $00292F10);
    if Hovered then FillColor := MintPalette($00607613, $00BDD06B);
    if Pressed then FillColor := MintPalette($0052660F, $00ADBF5E);
    BorderColor := FillColor;
  end else begin
    if Hovered then FillColor := MintPalette($00ECF3E1, $003F4221);
    if Pressed then FillColor := MintPalette($00E0EAD3, $00484D28);
  end;
  if Disabled then begin
    FillColor := MintPalette($00E9EEEB, $00332E27);
    BorderColor := MintPalette($00E4E8E1, $00423B32);
    TextColor := MintPalette($00AAAC9C, $008B8F82);
  end;
  FillBrush := MintCreateSolidBrush(FillColor);
  BorderPen := MintCreatePen(0, ScaleX(1), BorderColor);
  CrossPen := 0;
  Saved := MintSaveDC(Item.DC);
  if MintProofDrawing then Log('MintPaint ' + IntToStr(Index) + ' rect=' +
    IntToStr(Item.Rect.Left) + ',' + IntToStr(Item.Rect.Top) + ',' +
    IntToStr(Item.Rect.Right) + ',' + IntToStr(Item.Rect.Bottom) +
    ' dc=' + IntToStr(Item.DC) + ' saved=' + IntToStr(Saved));
  try
    { Background is prepared outside owner-draw. Copying the entire cached area
      also preserves a themed parent's gradient, rather than guessing one RGB. }
    if MintBackgroundDCs[Index] <> 0 then
      MintStretchBlt(Item.DC, Item.Rect.Left, Item.Rect.Top,
        Item.Rect.Right - Item.Rect.Left, Item.Rect.Bottom - Item.Rect.Top,
        MintBackgroundDCs[Index], 0, 0, MintBackgroundWidths[Index], MintBackgroundHeights[Index], $00CC0020)
    else begin
      ParentBrush := MintCreateSolidBrush(MintBackgroundColors[Index]);
      MintFillRect(Item.DC, Item.Rect, ParentBrush);
      MintDeleteObject(ParentBrush);
    end;
    MintSelectObject(Item.DC, FillBrush);
    MintSelectObject(Item.DC, BorderPen);
    if CloseControl then begin
      if Hovered or Pressed then
        MintRectangle(Item.DC, Item.Rect.Left, Item.Rect.Top, Item.Rect.Right, Item.Rect.Bottom);
    end else begin
      Radius := ScaleX(12);
      if MintProofDrawing then Log('fill=' + IntToStr(FillBrush) + ' pen=' + IntToStr(BorderPen) +
        ' round=' + IntToStr(Ord(MintRoundRect(Item.DC, Item.Rect.Left, Item.Rect.Top,
        Item.Rect.Right, Item.Rect.Bottom, Radius, Radius))) +
        ' postrect=' + IntToStr(Item.Rect.Left) + ',' + IntToStr(Item.Rect.Top))
      else MintRoundRect(Item.DC, Item.Rect.Left, Item.Rect.Top, Item.Rect.Right, Item.Rect.Bottom, Radius, Radius);
    end;
    if CloseControl then begin
      CenterX := (Item.Rect.Left + Item.Rect.Right) div 2;
      CenterY := (Item.Rect.Top + Item.Rect.Bottom) div 2;
      CrossPen := MintCreatePen(0, ScaleX(2), TextColor);
      MintSelectObject(Item.DC, CrossPen);
      MintMoveTo(Item.DC, CenterX - ScaleX(4), CenterY - ScaleY(4), 0);
      MintLineTo(Item.DC, CenterX + ScaleX(4), CenterY + ScaleY(4));
      MintMoveTo(Item.DC, CenterX + ScaleX(4), CenterY - ScaleY(4), 0);
      MintLineTo(Item.DC, CenterX - ScaleX(4), CenterY + ScaleY(4));
    end else begin
      Font := MintFonts[Index];
      if Font <> 0 then MintSelectObject(Item.DC, Font);
      MintSetBackgroundMode(Item.DC, 1);
      MintSetTextColor(Item.DC, TextColor);
      TextRect := Item.Rect;
      TextRect.Left := TextRect.Left + ScaleX(6);
      TextRect.Right := TextRect.Right - ScaleX(6);
      if Pressed then begin
        TextRect.Top := TextRect.Top + ScaleY(1);
        TextRect.Bottom := TextRect.Bottom + ScaleY(1);
      end;
      Flags := $0001 or $0004 or $0020 or $8000;
      if (Item.ItemState and MintStateNoAccel) <> 0 then Flags := Flags or $00100000;
      if MintProofDrawing then Log('caption=' + MintCaptions[Index] + ' font=' + IntToStr(Font) +
        ' DrawText=' + IntToStr(MintDrawText(Item.DC, MintCaptions[Index], -1, TextRect, Flags)))
      else MintDrawText(Item.DC, MintCaptions[Index], -1, TextRect, Flags);
    end;
    if Focused and not Disabled then begin
      FocusRect := Item.Rect;
      FocusRect.Left := FocusRect.Left + ScaleX(4);
      FocusRect.Top := FocusRect.Top + ScaleY(4);
      FocusRect.Right := FocusRect.Right - ScaleX(4);
      FocusRect.Bottom := FocusRect.Bottom - ScaleY(4);
      MintDrawFocusRect(Item.DC, FocusRect);
    end;
  finally
    if Saved <> 0 then MintRestoreDC(Item.DC, Saved);
    if CrossPen <> 0 then MintDeleteObject(CrossPen);
    MintDeleteObject(BorderPen);
    MintDeleteObject(FillBrush);
  end;
end;

function MintParentWindowProc(Window: HWND; Msg: Cardinal; WParam: NativeUInt;
  LParam: NativeInt; Id, RefData: NativeUInt): NativeInt;
var Item: TMintDrawItem;
begin
  if MintStopping then begin
    Result := DefSubclassProc(Window, Msg, WParam, LParam);
    Exit;
  end;
  if Msg = WM_NCDESTROY then begin
    RemoveWindowSubclass(Window, MintParentCallback, MintParentSubclassId);
    Result := DefSubclassProc(Window, Msg, WParam, LParam);
    Exit;
  end;
  if (Msg = MintDrawItemMessage) and (LParam <> 0) then begin
    MintReadDrawItem(Item, LParam, SizeOf(Item));
    if MintPaintButton(Item) then begin Result := 1; Exit; end;
  end;
  Result := DefSubclassProc(Window, Msg, WParam, LParam);
end;

function MintButtonWindowProc(Window: HWND; Msg: Cardinal; WParam: NativeUInt;
  LParam: NativeInt; Id, RefData: NativeUInt): NativeInt;
var Tracking: TMintMouseTracking; Index: Integer;
begin
  if MintStopping then begin
    Result := DefSubclassProc(Window, Msg, WParam, LParam);
    Exit;
  end;
  if Msg = WM_NCDESTROY then begin
    if MintHoveredWindow = Window then MintHoveredWindow := 0;
    RemoveWindowSubclass(Window, MintButtonCallback, MintControlSubclassId);
    Result := DefSubclassProc(Window, Msg, WParam, LParam);
    Exit;
  end;
  if Msg = MintSetStyle then WParam := (WParam and not MintButtonTypeBits) or MintOwnerDraw;
  if Msg = MintMouseMove then begin
    if MintHoveredWindow <> Window then begin
      if MintHoveredWindow <> 0 then MintInvalidate(MintHoveredWindow, 0, False);
      MintHoveredWindow := Window;
      Tracking.Bytes := SizeOf(Tracking);
      Tracking.Flags := 2;
      Tracking.Window := Window;
      Tracking.HoverTime := 0;
      Tracking.Padding := 0;
      MintTrackMouse(Tracking);
      MintInvalidate(Window, 0, False);
    end;
  end;
  if Msg = MintMouseLeave then begin
    if MintHoveredWindow = Window then MintHoveredWindow := 0;
    MintInvalidate(Window, 0, False);
  end;
  Result := DefSubclassProc(Window, Msg, WParam, LParam);
  if Msg = MintGetDialogCode then begin
    Index := MintButtonIndex(Window);
    if (Index >= 0) and MintDefaults[Index] then
      Result := (Result and not MintUndefaultDialogCode) or MintDefaultDialogCode;
  end;
end;

procedure MintEnsureInitialized;
var DrawItemLayout: TMintDrawItem; MouseLayout: TMintMouseTracking;
begin
  if MintInitialized then Exit;
  MintInitialized := True;
  MintEnabled := not HighContrastActive;
  if (SizeOf(DrawItemLayout) <> 64) or (SizeOf(MouseLayout) <> 24) then MintEnabled := False;
  if not MintEnabled then Exit;
  MintParentCallback := CreateCallback(@MintParentWindowProc);
  MintButtonCallback := CreateCallback(@MintButtonWindowProc);
end;

procedure MintRefreshButtons;
var I: Integer; Window, ParentWindow: HWND; Style: NativeInt; Font: NativeUInt;
  Changed, BackgroundChanged: Boolean;
begin
  if not MintEnabled or MintStopping then Exit;
#ifdef MintProgressProofInclude
  MintRefreshPassCount := MintRefreshPassCount + 1;
#endif
  for I := 0 to GetArrayLength(MintButtons) - 1 do begin
    if MintButtons[I] <> nil then begin
      MintButtons[I].StyleElements := [];
      Window := MintButtons[I].Handle;
      ParentWindow := MintGetParent(Window);
      Font := MintSendMessage(Window, MintGetFont, 0, 0);
      BackgroundChanged := (MintWindows[I] <> Window) or (MintParents[I] <> ParentWindow) or
        (MintBackgroundWidths[I] <> MintButtons[I].Width) or
        (MintBackgroundHeights[I] <> MintButtons[I].Height) or
        (MintBackgroundLefts[I] <> MintButtons[I].Left) or (MintBackgroundTops[I] <> MintButtons[I].Top) or
        (MintBackgroundParentWidths[I] <> MintButtons[I].Parent.Width) or
        (MintBackgroundParentHeights[I] <> MintButtons[I].Parent.Height) or (MintBackgroundDCs[I] = 0);
      Changed := BackgroundChanged or (MintCaptions[I] <> MintButtons[I].Caption) or
        (MintDefaults[I] <> MintButtons[I].Default) or (MintFonts[I] <> Font) or
        (MintCachedEnabled[I] <> MintButtons[I].Enabled);
      MintWindows[I] := Window;
      MintParents[I] := ParentWindow;
      MintCaptions[I] := MintButtons[I].Caption;
      MintDefaults[I] := MintButtons[I].Default;
      MintFonts[I] := Font;
      MintCachedEnabled[I] := MintButtons[I].Enabled;
      if BackgroundChanged then
        MintCacheButtonBackground(I, MintButtons[I].Width, MintButtons[I].Height);
      if SetWindowSubclass(ParentWindow, MintParentCallback, MintParentSubclassId, 0) and
        SetWindowSubclass(Window, MintButtonCallback, MintControlSubclassId, 0) then begin
        Style := GetWindowLongPtr(Window, GWL_STYLE);
        if (Style and MintButtonTypeBits) <> MintOwnerDraw then begin
          SetWindowLongPtr(Window, GWL_STYLE, (Style and not MintButtonTypeBits) or MintOwnerDraw);
          Changed := True;
        end;
        if Changed then begin
#ifdef MintProgressProofInclude
          MintRefreshInvalidationCount := MintRefreshInvalidationCount + 1;
#endif
          MintInvalidate(Window, 0, False);
        end;
      end else
        Log('Button styling could not be attached; the native button remains available.');
    end;
  end;
end;

procedure MintRegisterButton(Button: TNewButton; Role: Integer);
var I, Count: Integer;
begin
  MintEnsureInitialized;
  Count := GetArrayLength(MintButtons);
  I := 0;
  while (I < Count) and (MintButtons[I] <> nil) do I := I + 1;
  if I = Count then begin
    SetArrayLength(MintButtons, Count + 1);
    SetArrayLength(MintWindows, Count + 1);
    SetArrayLength(MintParents, Count + 1);
    SetArrayLength(MintFonts, Count + 1);
    SetArrayLength(MintCaptions, Count + 1);
    SetArrayLength(MintDefaults, Count + 1);
    SetArrayLength(MintRoles, Count + 1);
    SetArrayLength(MintCachedEnabled, Count + 1);
    SetArrayLength(MintBackgroundDCs, Count + 1);
    SetArrayLength(MintBackgroundBitmaps, Count + 1);
    SetArrayLength(MintBackgroundOldBitmaps, Count + 1);
    SetArrayLength(MintBackgroundWidths, Count + 1);
    SetArrayLength(MintBackgroundHeights, Count + 1);
    SetArrayLength(MintBackgroundStatus, Count + 1);
    SetArrayLength(MintBackgroundColors, Count + 1);
    SetArrayLength(MintBackgroundLefts, Count + 1);
    SetArrayLength(MintBackgroundTops, Count + 1);
    SetArrayLength(MintBackgroundParentWidths, Count + 1);
    SetArrayLength(MintBackgroundParentHeights, Count + 1);
  end;
  MintButtons[I] := Button;
  MintRoles[I] := Role;
  MintRefreshButtons;
end;

procedure MintUnregisterParent(ParentWindow: HWND);
var I: Integer;
begin
  for I := 0 to GetArrayLength(MintButtons) - 1 do
    if MintParents[I] = ParentWindow then begin
      if MintWindows[I] <> 0 then
        RemoveWindowSubclass(MintWindows[I], MintButtonCallback, MintControlSubclassId);
      MintButtons[I] := nil;
      MintWindows[I] := 0;
      MintParents[I] := 0;
      MintFonts[I] := 0;
      MintCaptions[I] := '';
      MintFreeButtonBackground(I);
    end;
  if MintParentCallback <> 0 then
    RemoveWindowSubclass(ParentWindow, MintParentCallback, MintParentSubclassId);
end;

procedure MintInitializeButtons(CloseButton: TNewButton);
begin
  MintRegisterButton(WizardForm.NextButton, 0);
  MintRegisterButton(WizardForm.BackButton, 1);
  MintRegisterButton(WizardForm.CancelButton, 1);
  MintRegisterButton(WizardForm.DirBrowseButton, 1);
  MintRegisterButton(WizardForm.GroupBrowseButton, 1);
  MintRegisterButton(CloseButton, 2);
end;

procedure MintShutdownButtons;
var I: Integer;
begin
  if MintStopping then Exit;
  MintStopping := True;
  MintEnabled := False;
  for I := 0 to GetArrayLength(MintWindows) - 1 do begin
    if (MintWindows[I] <> 0) and (MintButtonCallback <> 0) then
      RemoveWindowSubclass(MintWindows[I], MintButtonCallback, MintControlSubclassId);
    if (MintParents[I] <> 0) and (MintParentCallback <> 0) then
      RemoveWindowSubclass(MintParents[I], MintParentCallback, MintParentSubclassId);
    MintFreeButtonBackground(I);
  end;
  MintHoveredWindow := 0;
end;

procedure MintWriteOptionalPainterProof;
var
  ProofPath, LabelText, SavedNextCaption, SavedBackCaption: String;
  Bitmap: TBitmap;
  Item: TMintDrawItem;
  Column, Row, Index: Integer;
  SavedHover: HWND;
  ProofDC: NativeUInt;
  ProofBackground: Cardinal;
begin
  ProofPath := ExpandConstant('{param:MINTBUTTONPROOF|}');
  if (ProofPath = '') or not MintEnabled then Exit;
  { Explicit local QA export only; no clicks, installation or printer operation. }
  if not DirExists(ExtractFileDir(ProofPath)) then Exit;
  Bitmap := TBitmap.Create;
  SavedHover := MintHoveredWindow;
  MintProofDrawing := True;
  SavedNextCaption := MintCaptions[0];
  SavedBackCaption := MintCaptions[1];
  { InitializeWizard precedes Inno's page captions. These examples are proof-only. }
  MintCaptions[0] := SetupMessage(msgButtonNext);
  MintCaptions[1] := SetupMessage(msgButtonBack);
  try
    try
      Bitmap.Width := ScaleX(770);
      Bitmap.Height := ScaleY(252);
      ProofBackground := MintBackgroundColors[0];
      if MintBackgroundDCs[0] <> 0 then ProofBackground := MintPixel(MintBackgroundDCs[0], 0, 0);
      if ProofBackground = $FFFFFFFF then ProofBackground := MintBackgroundColors[0];
      Bitmap.Canvas.Brush.Color := ProofBackground;
      Bitmap.Canvas.Pen.Color := Bitmap.Canvas.Brush.Color;
      Bitmap.Canvas.Rectangle(0, 0, Bitmap.Width, Bitmap.Height);
      Bitmap.Canvas.Font.Name := 'Segoe UI';
      Bitmap.Canvas.Font.Size := 9;
      Bitmap.Canvas.Font.Color := MintPalette($002E3616, $00F1F2EA);
      Bitmap.Canvas.Brush.Style := bsClear;
      Bitmap.Canvas.TextOut(ScaleX(12), ScaleY(8), 'Mira Mint: actual owner-draw painter; no installation');
      for Column := 0 to 4 do begin
        case Column of
          0: LabelText := 'Normal';
          1: LabelText := 'Hover';
          2: LabelText := 'Pressed';
          3: LabelText := 'Focus';
          4: LabelText := 'Disabled';
        end;
        Bitmap.Canvas.TextOut(ScaleX(16 + Column * 150), ScaleY(32), LabelText);
      end;
      ProofDC := Bitmap.Canvas.Handle;
      for Column := 0 to 4 do begin
        for Row := 0 to 2 do begin
          if Row = 2 then Index := 5 else Index := Row;
          Item.ControlType := 4;
          Item.ControlId := 0;
          Item.ItemId := 0;
          Item.ItemAction := 1;
          Item.ItemState := 0;
          Item.Padding := 0;
          Item.Window := MintWindows[Index];
          Item.DC := ProofDC;
          Item.ItemData := 0;
          Item.Rect.Left := ScaleX(12 + Column * 150);
          Item.Rect.Top := ScaleY(58 + Row * 60);
          Item.Rect.Right := Item.Rect.Left + ScaleX(136);
          Item.Rect.Bottom := Item.Rect.Top + ScaleY(34);
          if Row = 2 then Item.Rect.Right := Item.Rect.Left + ScaleX(34);
          MintHoveredWindow := 0;
          case Column of
            1: MintHoveredWindow := Item.Window;
            2: Item.ItemState := MintStateSelected;
            3: Item.ItemState := MintStateFocus;
            4: Item.ItemState := MintStateDisabled;
          end;
          MintPaintButton(Item);
        end;
      end;
      Bitmap.SaveToFile(ProofPath);
    except
      Log('Optional button painter proof failed: ' + GetExceptionMessage);
    end;
  finally
    MintProofDrawing := False;
    MintCaptions[0] := SavedNextCaption;
    MintCaptions[1] := SavedBackCaption;
    MintHoveredWindow := SavedHover;
    Bitmap.Free;
  end;
end;


