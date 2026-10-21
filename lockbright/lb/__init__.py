"""LockBright — lock-screen-aware display dimmer.

Locks the screen -> periodically checks camera luminance -> when the room goes
dark, dims the built-in display to the configured minimum; restores brightness
when the lights come back, on unlock, and every morning at a fixed time.
"""

__version__ = "0.1.0"
