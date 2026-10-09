# DPAPI 解密助手：stdin 读 base64 密文，stdout 输出 base64 明文。
# 用于解开 Qoder "Local State" 里 os_crypt.encrypted_key 的 DPAPI 包裹层。
# 密文只经 stdin 传递，不出现在命令行参数/进程列表里。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
if ([string]::IsNullOrWhiteSpace($b64)) {
  [Console]::Error.WriteLine('empty input')
  exit 1
}
$bytes = [Convert]::FromBase64String($b64)
$out = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.WriteLine([Convert]::ToBase64String($out))
