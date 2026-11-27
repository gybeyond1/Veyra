"""Compile the GPL upstream Kotlin runtime without changing the Java app toolchain."""
import argparse
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--classpath", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
home = Path(os.environ.get("KOTLIN_HOME", r"C:\Program Files\Android\Android Studio\plugins\Kotlin\kotlinc"))
compiler = home / "lib/kotlin-compiler.jar"
if not compiler.is_file():
    raise SystemExit("请安装 Android Studio 或设置 KOTLIN_HOME 指向 Kotlin 编译器目录")
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
sources = sorted((root / "third_party/hongguo/src").rglob("*.kt"))
# Android Studio 自带 JBR；Linux 上 KOTLIN_HOME 常直接指向 kotlinc，没有 jbr 那一层，
# 取 parents[2] 会直接 IndexError。取不到就用 PATH 里的 java。
java = "java"
try:
    studio_java = home.parents[2] / "jbr/bin/java.exe"
    if studio_java.is_file():
        java = str(studio_java)
except IndexError:
    pass
subprocess.run([java, "-Dfile.encoding=UTF-8", "-cp", str(home / "lib/*"),
                "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect",
                "-jvm-target", "17", "-classpath", args.classpath,
                "-d", str(output), *map(str, sources)], check=True)
