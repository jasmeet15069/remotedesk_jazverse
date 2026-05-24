@echo off
setlocal
set "RD_BAT=%~f0"
set "RD_TMP=%TEMP%\RemoteDeskHost-%RANDOM%%RANDOM%.ps1"

echo Starting RemoteDesk Host...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$marker='###REMOTE_DESK_PS1###'; $text=[IO.File]::ReadAllText($env:RD_BAT); $idx=$text.IndexOf($marker); if($idx -lt 0){throw 'RemoteDesk payload missing'}; $payload=$text.Substring($idx + $marker.Length).TrimStart([char]13,[char]10); [IO.File]::WriteAllText($env:RD_TMP, $payload, [Text.UTF8Encoding]::new($false))"
if errorlevel 1 (
  echo.
  echo RemoteDesk could not prepare the host helper.
  pause
  exit /b 1
)

powershell -STA -NoProfile -ExecutionPolicy Bypass -File "%RD_TMP%"
set "RD_EXIT=%ERRORLEVEL%"
del "%RD_TMP%" >nul 2>nul
if not "%RD_EXIT%"=="0" (
  echo.
  echo RemoteDesk Host stopped with error code %RD_EXIT%.
  pause
)
exit /b %RD_EXIT%

###REMOTE_DESK_PS1###$ErrorActionPreference = "Stop"
try {

$Server = "https://remotedesk.jazverse.online"
$script:Code = ""
$script:IsBusy = $false
$script:SessionReady = $false
$script:LastSessionCheck = [datetime]::MinValue
$script:LastStatus = "Starting RemoteDesk Host..."

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RemoteDeskPoint {
  public int X;
  public int Y;
}
public class RemoteDeskInput {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out RemoteDeskPoint lpPoint);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
}
"@

function Normalize-Code($Value) {
  return (($Value -as [string]) -replace "\s", "")
}

function Show-CodeDialog {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "RemoteDesk Host"
  $form.Size = New-Object System.Drawing.Size(380, 170)
  $form.StartPosition = "CenterScreen"
  $form.FormBorderStyle = "FixedDialog"
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false

  $label = New-Object System.Windows.Forms.Label
  $label.Text = "Enter approved RemoteDesk session code"
  $label.AutoSize = $true
  $label.Location = New-Object System.Drawing.Point(18, 18)
  $form.Controls.Add($label)

  $text = New-Object System.Windows.Forms.TextBox
  $text.Location = New-Object System.Drawing.Point(20, 48)
  $text.Width = 320
  $form.Controls.Add($text)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = "Start"
  $ok.Location = New-Object System.Drawing.Point(185, 88)
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.AcceptButton = $ok
  $form.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = "Cancel"
  $cancel.Location = New-Object System.Drawing.Point(265, 88)
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.CancelButton = $cancel
  $form.Controls.Add($cancel)

  $result = $form.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK -or [string]::IsNullOrWhiteSpace($text.Text)) {
    return $null
  }
  return $text.Text.Trim()
}

function Get-Session {
  try {
    return Invoke-RestMethod -Uri "$Server/api/session" -Method Get
  } catch {
    $script:LastStatus = "Could not read website session: " + $_.Exception.Message
    return $null
  }
}

function Test-SessionReady {
  if (((Get-Date) - $script:LastSessionCheck).TotalSeconds -lt 2) {
    return $script:SessionReady
  }
  $script:LastSessionCheck = Get-Date
  $script:SessionReady = $false

  $status = Get-Session
  if ($null -eq $status) {
    return $false
  }

  $session = $status.session
  if ((Normalize-Code $script:Code) -ne (Normalize-Code $session.code)) {
    $script:LastStatus = "Wrong or old code. Website currently shows: " + $session.code
    return $false
  }
  if (-not $session.approved) {
    $script:LastStatus = "Code correct, waiting for Approve session on website."
    return $false
  }
  if (-not $session.permissions.screen) {
    $script:LastStatus = "Share screen is off. Enable it and approve again."
    return $false
  }
  $script:SessionReady = $true
  return $true
}

function Send-Stop {
  try {
    Invoke-RestMethod -Uri "$Server/api/screen/stop" -Method Post -ContentType "application/json" -Body "{}" | Out-Null
  } catch {
  }
}

function Capture-Frame {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
    $maxWidth = 720
    if ($bitmap.Width -gt $maxWidth) {
      $scale = $maxWidth / $bitmap.Width
      $targetWidth = [int]($bitmap.Width * $scale)
      $targetHeight = [int]($bitmap.Height * $scale)
      $resized = New-Object System.Drawing.Bitmap $targetWidth, $targetHeight
      $resizedGraphics = [System.Drawing.Graphics]::FromImage($resized)
      try {
        $resizedGraphics.DrawImage($bitmap, 0, 0, $targetWidth, $targetHeight)
      } finally {
        $resizedGraphics.Dispose()
        $bitmap.Dispose()
      }
      $bitmap = $resized
    }

    $stream = New-Object System.IO.MemoryStream
    try {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      return @{
        image = "data:image/jpeg;base64," + [Convert]::ToBase64String($stream.ToArray())
        width = $bitmap.Width
        height = $bitmap.Height
      }
    } finally {
      $stream.Dispose()
    }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Move-Mouse($X, $Y) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $screenX = [int]($bounds.Left + ($bounds.Width * [double]$X))
  $screenY = [int]($bounds.Top + ($bounds.Height * [double]$Y))
  [RemoteDeskInput]::SetCursorPos($screenX, $screenY) | Out-Null
}

function Move-MouseDelta($DX, $DY) {
  $point = New-Object RemoteDeskPoint
  if ([RemoteDeskInput]::GetCursorPos([ref]$point)) {
    $scale = 1.6
    $screenX = [int]($point.X + ([double]$DX * $scale))
    $screenY = [int]($point.Y + ([double]$DY * $scale))
    [RemoteDeskInput]::SetCursorPos($screenX, $screenY) | Out-Null
  }
}

function Send-MouseDown($X, $Y) {
  Move-Mouse $X $Y
  [RemoteDeskInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-MouseUp($X, $Y) {
  Move-Mouse $X $Y
  [RemoteDeskInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-Click($X, $Y) {
  Send-MouseDown $X $Y
  Start-Sleep -Milliseconds 40
  Send-MouseUp $X $Y
}

function Send-LeftClickCurrent {
  [RemoteDeskInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [RemoteDeskInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-RightClickCurrent {
  [RemoteDeskInput]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [RemoteDeskInput]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-Scroll($X, $Y, $DeltaY) {
  Move-Mouse $X $Y
  $wheel = 0
  if ([double]$DeltaY -gt 0) { $wheel = -120 }
  if ([double]$DeltaY -lt 0) { $wheel = 120 }
  if ($wheel -ne 0) {
    [RemoteDeskInput]::mouse_event(0x0800, 0, 0, $wheel, [UIntPtr]::Zero)
  }
}

function Escape-SendKeysText($Text) {
  $escaped = [string]$Text
  foreach ($ch in @('{', '}', '+', '^', '%', '~', '(', ')', '[', ']')) {
    $escaped = $escaped.Replace($ch, "{$ch}")
  }
  return $escaped
}

function Send-Key($Key) {
  $map = @{
    "Enter" = "{ENTER}"
    "Backspace" = "{BACKSPACE}"
    "Esc" = "{ESC}"
    "Tab" = "{TAB}"
    "Alt" = "%"
    "Ctrl" = "^"
  }
  if ($map.ContainsKey($Key)) {
    [System.Windows.Forms.SendKeys]::SendWait($map[$Key])
  }
}

function Poll-Commands {
  try {
    $encoded = [Uri]::EscapeDataString($script:Code)
    $result = Invoke-RestMethod -Uri "$Server/api/control/poll?code=$encoded" -Method Get
    foreach ($command in $result.commands) {
      if ($command.type -eq "mouseMove") {
        Move-Mouse $command.x $command.y
        $script:LastStatus = "Mouse move received at " + (Get-Date -Format "HH:mm:ss")
      }
      if ($command.type -eq "mouseDelta") {
        Move-MouseDelta $command.dx $command.dy
        $script:LastStatus = "Touchpad move received at " + (Get-Date -Format "HH:mm:ss")
      }
      if ($command.type -eq "mouseDown") {
        Send-MouseDown $command.x $command.y
        $script:LastStatus = "Mouse down received at " + (Get-Date -Format "HH:mm:ss")
      }
      if ($command.type -eq "mouseUp") {
        Send-MouseUp $command.x $command.y
        $script:LastStatus = "Mouse up received at " + (Get-Date -Format "HH:mm:ss")
      }
      if ($command.type -eq "click") {
        Send-Click $command.x $command.y
        $script:LastStatus = "Mouse click received at " + (Get-Date -Format "HH:mm:ss")
      }
      if ($command.type -eq "leftClick") {
        Send-LeftClickCurrent
        $script:LastStatus = "Left click received at " + (Get-Date -Format "HH:mm:ss")
      }
      if ($command.type -eq "rightClick") {
        Send-RightClickCurrent
        $script:LastStatus = "Right click received at " + (Get-Date -Format "HH:mm:ss")
      }
      if ($command.type -eq "scroll") {
        Send-Scroll $command.x $command.y $command.deltaY
        $script:LastStatus = "Scroll received at " + (Get-Date -Format "HH:mm:ss")
      }
      if ($command.type -eq "key") {
        Send-Key $command.key
        $script:LastStatus = "Key received: " + $command.key
      }
      if ($command.type -eq "text") {
        [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeysText $command.text))
        $script:LastStatus = "Text received at " + (Get-Date -Format "HH:mm:ss")
      }
    }
  } catch {
    $script:LastStatus = "Control poll failed: " + $_.Exception.Message
  }
}

function Send-FrameTick {
  if ($script:IsBusy) {
    return
  }
  $script:IsBusy = $true
  try {
    if (-not (Test-SessionReady)) {
      return
    }
    $frame = Capture-Frame
    $payload = @{
      code = $script:Code
      image = $frame.image
      width = $frame.width
      height = $frame.height
    } | ConvertTo-Json -Compress

    Invoke-RestMethod -Uri "$Server/api/screen/frame" -Method Post -ContentType "application/json" -Body $payload | Out-Null
    $script:LastStatus = "Sharing live at " + (Get-Date -Format "HH:mm:ss")
  } catch {
    $script:LastStatus = "Sharing issue: " + $_.Exception.Message
  } finally {
    $script:IsBusy = $false
  }
}

$script:Code = Show-CodeDialog
if ($null -eq $script:Code) {
  exit
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = "RemoteDesk Host running"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Text = "Show status"
$statusItem.Add_Click({
  [System.Windows.Forms.MessageBox]::Show($script:LastStatus, "RemoteDesk Host")
})
$menu.Items.Add($statusItem) | Out-Null

$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem
$stopItem.Text = "Stop RemoteDesk Host"
$stopItem.Add_Click({
  Send-Stop
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($stopItem) | Out-Null

$notify.ContextMenuStrip = $menu
$notify.ShowBalloonTip(2500, "RemoteDesk Host", "Running in the system tray. Right-click the tray icon to stop.", [System.Windows.Forms.ToolTipIcon]::Info)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 180
$timer.Add_Tick({ Send-FrameTick })
$timer.Start()

$controlTimer = New-Object System.Windows.Forms.Timer
$controlTimer.Interval = 80
$controlTimer.Add_Tick({ Poll-Commands })
$controlTimer.Start()

[System.Windows.Forms.Application]::Run()
$controlTimer.Stop()
$timer.Stop()
Send-Stop
$notify.Dispose()
} catch {
  $message = "RemoteDesk Host stopped: " + $_.Exception.Message
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show($message, "RemoteDesk Host Error") | Out-Null
  } catch {
  }
  Write-Host ""
  Write-Host $message -ForegroundColor Red
  Write-Host ""
  Write-Host "Press Enter to close this window."
  [Console]::ReadLine() | Out-Null
  exit 1
}
