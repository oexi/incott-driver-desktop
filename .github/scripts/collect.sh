#!/usr/bin/env bash
# 把 tauri build 的产物整理成发布用的文件名（与 1.x 相同）：incott-driver-<版本>-<系统>-<架构>.<扩展名>
# 用法: collect.sh <矩阵名，如 linux-x64> <Rust target> ；输出到 dist-release/
set -euo pipefail

name="$1"
target="$2"
ver=$(node -p "require('./package.json').version")
bundle="src-tauri/target/$target/release/bundle"
bin="src-tauri/target/$target/release"
out="dist-release"
p="incott-driver-$ver"
mkdir -p "$out"

one() {
  # 某个目录下应当正好有一个匹配的文件
  local files=("$@")
  if [ "${#files[@]}" -ne 1 ] || [ ! -e "${files[0]}" ]; then
    echo "expected exactly one file, got: ${files[*]}" >&2
    exit 1
  fi
  echo "${files[0]}"
}

case "$name" in
  linux-x64 | linux-arm64)
    if [ "$name" = linux-x64 ]; then
      deb=amd64 rpm=x86_64 appimage=x86_64 pacman=x64 tgz=x64 arch=x86_64
    else
      deb=arm64 rpm=aarch64 appimage=arm64 pacman=aarch64 tgz=arm64 arch=aarch64
    fi
    cp "$(one "$bundle"/deb/*.deb)" "$out/$p-linux-$deb.deb"
    cp "$(one "$bundle"/rpm/*.rpm)" "$out/$p-linux-$rpm.rpm"
    cp "$(one "$bundle"/appimage/*.AppImage)" "$out/$p-linux-$appimage.AppImage"

    # pacman：把 deb 里的文件原样打成 Arch 包。包名与 1.x 相同，pacman -U 可以直接升级
    root=$(mktemp -d)
    dpkg-deb -x "$out/$p-linux-$deb.deb" "$root"
    fpm -s dir -t pacman -C "$root" \
      -n incott-driver-desktop -v "$ver" --iteration 1 -a "$arch" \
      --description "INCOTT mouse driver" \
      --url "https://github.com/oexi/incott-driver-desktop" \
      --license MIT --maintainer "oexi <oexi@users.noreply.github.com>" \
      -d webkit2gtk-4.1 -d gtk3 -d libayatana-appindicator \
      -p "$out/$p-linux-$pacman.pacman" .

    # tar.gz：可执行文件 + udev 规则 + 图标 + 许可证
    tmp=$(mktemp -d)
    dir="$tmp/incott-driver-$ver"
    mkdir -p "$dir"
    cp "$bin/incott-driver" "$dir/"
    cp build/linux/70-incott-mouse.rules LICENSE NOTICE "$dir/"
    cp build/icon.png "$dir/incott-driver.png"
    tar -C "$tmp" -czf "$out/$p-linux-$tgz.tar.gz" "incott-driver-$ver"
    ;;

  win-x64 | win-arm64)
    a="${name#win-}"
    cp "$(one "$bundle"/nsis/*-setup.exe)" "$out/$p-win-$a-setup.exe"
    # 免安装版：可执行文件本身就是完整的程序（界面资源已嵌入），需要系统装有 WebView2
    cp "$bin/incott-driver.exe" "$out/$p-win-$a-portable.exe"
    ;;

  mac-x64 | mac-arm64)
    a="${name#mac-}"
    cp "$(one "$bundle"/dmg/*.dmg)" "$out/$p-mac-$a.dmg"
    ditto -c -k --keepParent "$bundle/macos/Incott Driver.app" "$out/$p-mac-$a.zip"
    ;;

  *)
    echo "unknown matrix name: $name" >&2
    exit 1
    ;;
esac

ls -la "$out"
