# omp 的 Python 内核 spawn 环境走白名单，PYTHONUTF8 传不进去；这里兜住 open() 的默认编码。
import builtins
import io

_ORIGINAL = io.open


def _open(file, mode="r", buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
    if (encoding is None or encoding == "locale") and "b" not in mode:
        encoding = "utf-8"
    return _ORIGINAL(file, mode, buffering, encoding, errors, newline, closefd, opener)


io.open = _open
builtins.open = _open
