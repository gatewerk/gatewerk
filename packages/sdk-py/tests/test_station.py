"""Tests for the deprecated Station class."""

from __future__ import annotations

import warnings
from unittest.mock import patch, MagicMock

import httpx
import pytest

from gatewerk import Station


BASE_URL = "http://localhost:3000"
API_KEY = "test-api-key-123"


class TestStation:
    def test_emits_deprecation_warning(self):
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            Station(BASE_URL, API_KEY)
            assert len(w) == 1
            assert issubclass(w[0].category, DeprecationWarning)
            assert "deprecated" in str(w[0].message).lower()

    @patch("gatewerk.station.httpx.post")
    def test_review_sends_post(self, mock_post):
        mock_post.return_value = httpx.Response(
            201,
            json={"id": "rev_001", "status": "pending"},
            request=httpx.Request("POST", f"{BASE_URL}/api/v1/reviews"),
        )

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            station = Station(BASE_URL, API_KEY)

        result = station.review(
            template="deploy",
            payload={"action": "deploy-v2"},
            callback_url="https://agent.example/hook",
            priority="high",
        )

        mock_post.assert_called_once()
        assert result["id"] == "rev_001"

    @patch("gatewerk.station.httpx.post")
    def test_review_raises_on_error(self, mock_post):
        mock_post.return_value = httpx.Response(
            400,
            json={"error": "bad request"},
            request=httpx.Request("POST", f"{BASE_URL}/api/v1/reviews"),
        )

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            station = Station(BASE_URL, API_KEY)

        with pytest.raises(httpx.HTTPStatusError):
            station.review(template="deploy", payload={}, callback_url="https://example.com")

    @patch("gatewerk.station.time.sleep", return_value=None)
    @patch("gatewerk.station.httpx.get")
    @patch("gatewerk.station.httpx.post")
    def test_review_and_wait_polls(self, mock_post, mock_get, mock_sleep):
        mock_post.return_value = httpx.Response(
            201,
            json={"id": "rev_002", "status": "pending"},
            request=httpx.Request("POST", f"{BASE_URL}/api/v1/reviews"),
        )

        pending = httpx.Response(200, json={"id": "rev_002", "status": "pending"}, request=httpx.Request("GET", ""))
        decided = httpx.Response(200, json={"id": "rev_002", "status": "decided", "decision": "approved"}, request=httpx.Request("GET", ""))
        mock_get.side_effect = [pending, decided]

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            station = Station(BASE_URL, API_KEY)

        result = station.review_and_wait(
            template="deploy",
            payload={"action": "deploy-v2"},
            callback_url="https://agent.example/hook",
            poll_interval=0.1,
            timeout=10.0,
        )

        assert mock_get.call_count == 2
        assert result["decision"] == "approved"

    @patch("gatewerk.station.time.sleep", return_value=None)
    @patch("gatewerk.station.httpx.get")
    @patch("gatewerk.station.httpx.post")
    def test_review_and_wait_does_not_resolve_on_awaiting(self, mock_post, mock_get, mock_sleep):
        """awaiting_iteration / awaiting_external are non-terminal — keep polling."""
        mock_post.return_value = httpx.Response(
            201,
            json={"id": "rev_005", "status": "pending"},
            request=httpx.Request("POST", f"{BASE_URL}/api/v1/reviews"),
        )

        iteration = httpx.Response(200, json={"id": "rev_005", "status": "awaiting_iteration"}, request=httpx.Request("GET", ""))
        external = httpx.Response(200, json={"id": "rev_005", "status": "awaiting_external"}, request=httpx.Request("GET", ""))
        decided = httpx.Response(200, json={"id": "rev_005", "status": "decided", "decision": "approved"}, request=httpx.Request("GET", ""))
        mock_get.side_effect = [iteration, external, decided]

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            station = Station(BASE_URL, API_KEY)

        result = station.review_and_wait(
            template="deploy",
            payload={"action": "deploy-v2"},
            callback_url="https://agent.example/hook",
            poll_interval=0.1,
            timeout=10.0,
        )

        # Must poll past both awaiting_* states to the terminal decided.
        assert mock_get.call_count == 3
        assert result["status"] == "decided"

    @patch("gatewerk.station.time.sleep", return_value=None)
    @patch("gatewerk.station.time.monotonic")
    @patch("gatewerk.station.httpx.get")
    @patch("gatewerk.station.httpx.post")
    def test_review_and_wait_timeout(self, mock_post, mock_get, mock_monotonic, mock_sleep):
        mock_post.return_value = httpx.Response(
            201,
            json={"id": "rev_003", "status": "pending"},
            request=httpx.Request("POST", f"{BASE_URL}/api/v1/reviews"),
        )
        mock_get.return_value = httpx.Response(
            200,
            json={"id": "rev_003", "status": "pending"},
            request=httpx.Request("GET", ""),
        )
        mock_monotonic.side_effect = [0.0, 5.1]

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            station = Station(BASE_URL, API_KEY)

        with pytest.raises(TimeoutError, match="still pending"):
            station.review_and_wait(
                template="deploy",
                payload={},
                callback_url="https://example.com",
                poll_interval=0.1,
                timeout=5.0,
            )

    @patch("gatewerk.station.httpx.get")
    def test_feedback(self, mock_get):
        mock_get.return_value = httpx.Response(
            200,
            json={"items": [{"review_id": "rev_010"}], "total": 1, "has_more": False},
            request=httpx.Request("GET", ""),
        )

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            station = Station(BASE_URL, API_KEY)

        result = station.feedback(template="deploy", outcome="approved", limit=10)
        assert result["total"] == 1
