$ErrorActionPreference = "Stop"

$Server = "https://remotedesk.jazverse.online"
$script:Code = ""
$script:IsBusy = $false
$script:LastStatus = "Starting RemoteDesk Host..."

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RemoteDeskInput {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
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
    $maxWidth = 960
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

function Send-Click($X, $Y) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $screenX = [int]($bounds.Left + ($bounds.Width * [double]$X))
  $screenY = [int]($bounds.Top + ($bounds.Height * [double]$Y))
  [RemoteDeskInput]::SetCursorPos($screenX, $screenY) | Out-Null
  [RemoteDeskInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [RemoteDeskInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
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
      if ($command.type -eq "click") {
        Send-Click $command.x $command.y
        $script:LastStatus = "Mouse click received at " + (Get-Date -Format "HH:mm:ss")
      }
      if ($command.type -eq "key") {
        Send-Key $command.key
        $script:LastStatus = "Key received: " + $command.key
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
    Poll-Commands
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
$timer.Interval = 350
$timer.Add_Tick({ Send-FrameTick })
$timer.Start()

[System.Windows.Forms.Application]::Run()
$timer.Stop()
Send-Stop
$notify.Dispose()
