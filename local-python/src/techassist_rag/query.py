"""Expand common employee shorthand with laptop support terminology."""
import re


_ALIASES = (
    (r"\bbsod\b", "blue screen stop error"),
    (r"\bno post\b", "power-on self-test failure"),
    (r"\b(?:webcam|cam)\b", "camera"),
    (r"\b(?:touchpad|trackpad)\b", "laptop pointing device"),
    (r"\b(?:wifi|wi-fi|wlan)\b", "wireless network"),
    (r"\b(?:won['’]t|doesn['’]t|will not) charge\b", "battery not charging"),
    (r"\b(?:gets?|getting) (?:really |very |too )?hot\b", "overheating"),
    (r"\b(?:question-mark folder|folder with a question mark)\b", "Mac startup disk"),
)


def enhance_query(question: str) -> str:
    """Append up to three matching aliases without rewriting the supplied facts."""
    lower = question.casefold()
    terms = [
        term for pattern, term in _ALIASES
        if re.search(pattern, lower) and term not in lower
    ][:3]
    if not terms:
        return question
    return question.rstrip() + '\nRelated support terms: ' + '; '.join(terms)
