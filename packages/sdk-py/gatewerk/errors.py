"""Typed exception hierarchy for the Gatewerk Python SDK."""

from __future__ import annotations

from typing import Optional


class GatewerkError(Exception):
    """Base exception for all Gatewerk API errors."""

    def __init__(
        self,
        message: str,
        status_code: int = 0,
        code: str = "unknown",
        param: Optional[str] = None,
    ):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.param = param
        self.request_id: Optional[str] = None
        self.raw_body: Optional[str] = None


class InvalidRequestError(GatewerkError):
    """400 - Bad request (missing fields, invalid params)."""

    def __init__(
        self,
        message: str,
        param: Optional[str] = None,
        code: str = "invalid_request",
    ):
        super().__init__(message, status_code=400, code=code, param=param)


class AuthenticationError(GatewerkError):
    """401 - Invalid or missing API key."""

    def __init__(self, message: str = "Invalid or missing API key"):
        super().__init__(message, status_code=401, code="authentication_error")


class ForbiddenError(GatewerkError):
    """403 - Insufficient permissions."""

    def __init__(self, message: str = "Insufficient permissions"):
        super().__init__(message, status_code=403, code="forbidden")


class NotFoundError(GatewerkError):
    """404 - Resource not found."""

    def __init__(self, message: str, code: str = "not_found"):
        super().__init__(message, status_code=404, code=code)


class ConflictError(GatewerkError):
    """409 - Resource conflict (e.g., review already decided)."""

    def __init__(self, message: str, code: str = "conflict"):
        super().__init__(message, status_code=409, code=code)


class RateLimitError(GatewerkError):
    """429 - Rate limited."""

    def __init__(self, message: str = "Rate limit exceeded"):
        super().__init__(message, status_code=429, code="rate_limit")
        self.retry_after: Optional[float] = None
