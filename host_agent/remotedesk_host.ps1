$ErrorActionPreference = "Stop"

$Server = "https://remotedesk.jazverse.online"
$Code = Read-Host "Enter approved RemoteDesk session code"

if ([string]::IsNullOrWhiteSpace($Code)) {
  Write-Host "Session code is required."
  Read-Host "Press Enter to exit"
  exit 1
}

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

function Get-Session {
  try {
    return Invoke-RestMethod -Uri "$Server/api/session" -Method Get
  } catch {
    Write-Host ("Could not read website session: " + $_.Exception.Message)
    return $null
  }
}

function Test-SessionReady {
  $status = Get-Session
  if ($null -eq $status) {
    return $false
  }

  $session = $status.session
  if ((Normalize-Code $Code) -ne (Normalize-Code $session.code)) {
    Write-Host ("Wrong or old code. Website currently shows: " + $session.code)
    return $false
  }

  if (-not $session.approved) {
    Write-Host "Code is correct, but session is not approved. Click Approve session on the website."
    return $false
  }

  if (-not $session.permissions.screen) {
    Write-Host "Session is approved, but Share screen is off. Enable Share screen and approve again."
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
    $encoded = [Uri]::EscapeDataString($Code)
    $result = Invoke-RestMethod -Uri "$Server/api/control/poll?code=$encoded" -Method Get
    foreach ($command in $result.commands) {
      if ($command.type -eq "click") {
        Send-Click $command.x $command.y
        Write-Host ("Mouse click received at " + (Get-Date -Format "HH:mm:ss"))
      }
      if ($command.type -eq "key") {
        Send-Key $command.key
        Write-Host ("Key received: " + $command.key)
      }
    }
  } catch {
    Write-Host ("Control poll failed: " + $_.Exception.Message)
  }
}

Write-Host ""
Write-Host "RemoteDesk Host is visible and active."
Write-Host "Keep this window open. Press Ctrl+C or close it to stop sharing."
Write-Host ""

try {
  while ($true) {
    try {
      if (-not (Test-SessionReady)) {
        Start-Sleep -Milliseconds 1200
        continue
      }

      $frame = Capture-Frame
      $payload = @{
        code = $Code
        image = $frame.image
        width = $frame.width
        height = $frame.height
      } | ConvertTo-Json -Compress

      Invoke-RestMethod -Uri "$Server/api/screen/frame" -Method Post -ContentType "application/json" -Body $payload | Out-Null
      Poll-Commands
      Write-Host ("Frame sent at " + (Get-Date -Format "HH:mm:ss"))
    } catch {
      $message = $_.Exception.Message
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body = $reader.ReadToEnd() | ConvertFrom-Json
        if ($body.error) {
          $message = $body.error
        }
      } catch {
      }
      Write-Host ("Waiting for approved screen session: " + $message)
    }

    Start-Sleep -Milliseconds 350
  }
} finally {
  Send-Stop
}
