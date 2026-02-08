# Unified Transcript Scanner - Behavior Specification
# Date: 2026-02-08 08:25
# Phase: 0.2 - Behavior-Driven Development
# Format: Gherkin (Given/When/Then)

Feature: Unified Transcript Scanner
  As a statusline daemon
  I want to scan transcripts efficiently
  So that I can display accurate session data

  Background:
    Given the scanner is initialized with default config
    And all extractors are registered

  # ============================================================================
  # SCENARIO GROUP: Cache Behavior
  # ============================================================================

  Scenario: Cache hit returns immediately without disk I/O
    Given a transcript file exists at "/path/to/transcript.jsonl"
    And the transcript contains 100 lines
    And I have scanned the transcript 5 seconds ago
    When I scan the transcript again
    Then the result is returned in less than 2ms
    And no disk reads are performed
    And the metrics show cacheHit=true

  Scenario: Cache miss after TTL expiry triggers new scan
    Given a transcript file exists at "/path/to/transcript.jsonl"
    And I have scanned the transcript 11 seconds ago
    When I scan the transcript again
    Then the result is returned in less than 50ms
    And 1 disk read is performed
    And the metrics show cacheHit=false

  Scenario: Cache invalidation forces fresh scan
    Given a transcript file exists at "/path/to/transcript.jsonl"
    And I have scanned the transcript 1 second ago
    When I call clearCache()
    And I scan the transcript again
    Then the result is returned in less than 50ms
    And 1 disk read is performed
    And the metrics show cacheHit=false

  # ============================================================================
  # SCENARIO GROUP: Incremental Scanning
  # ============================================================================

  Scenario: First scan processes entire transcript
    Given a transcript file exists with 1000 lines
    And no state file exists for this session
    When I scan the transcript
    Then 1000 lines are parsed
    And the state file is created with offset=<file_size>
    And the metrics show bytesRead=<file_size>

  Scenario: Incremental scan processes only new lines
    Given a transcript file exists with 1000 lines
    And the state file shows offset=100000 bytes
    And 100 new lines have been added (10000 bytes)
    When I scan the transcript
    Then only 100 lines are parsed
    And the state file is updated with offset=110000
    And the metrics show bytesRead=10000

  Scenario: No new content returns cached state
    Given a transcript file exists with 1000 lines
    And the state file shows offset=100000 bytes, mtime=<timestamp>
    And the file has not been modified
    When I scan the transcript
    Then 0 lines are parsed
    And the state file is not modified
    And the metrics show bytesRead=0
    And the result uses cached extractor data from state

  Scenario: File reset (cleared transcript) triggers full scan
    Given a transcript file exists with 1000 lines
    And the state file shows offset=100000 bytes
    And the transcript file is cleared (size=0)
    When I scan the transcript
    Then the offset is reset to 0
    And the full file is scanned
    And the state file is updated with offset=0

  Scenario: File shrinkage (rotation) triggers full scan
    Given a transcript file exists with 1000 lines
    And the state file shows offset=100000 bytes
    And the transcript file is replaced with a smaller file (50000 bytes)
    When I scan the transcript
    Then the offset is reset to 0
    And the full file is scanned
    And the state file is updated with offset=50000

  # ============================================================================
  # SCENARIO GROUP: State Management
  # ============================================================================

  Scenario: State file is created on first scan
    Given a transcript file exists
    And no state file exists for "session-abc"
    When I scan the transcript for "session-abc"
    Then a state file is created at "~/.claude/session-health/scanners/session-abc.state"
    And the state file contains version=2
    And the state file contains lastOffset=<file_size>
    And the state file contains lastMtime=<mtime>
    And the state file contains extractorData

  Scenario: State file is updated after each scan
    Given a state file exists for "session-abc"
    And the transcript has new content
    When I scan the transcript for "session-abc"
    Then the state file is updated atomically
    And the lastOffset reflects the new file size
    And the lastMtime reflects the current mtime
    And the lastScanAt is updated to current timestamp

  Scenario: State file atomic write uses temp file
    Given a state file exists for "session-abc"
    When I scan the transcript and update state
    Then a temp file is created at "<path>.tmp"
    And the state is written to the temp file
    And the temp file is renamed to final path (atomic)
    And no orphan temp files remain

  Scenario: State file corruption is handled gracefully
    Given a state file exists for "session-abc"
    And the state file contains invalid JSON
    When I load the state for "session-abc"
    Then null is returned
    And a fresh state is created on next scan
    And no error is thrown

  # ============================================================================
  # SCENARIO GROUP: Migration from Old Formats
  # ============================================================================

  Scenario: Migrate from IncrementalTranscriptScanner state
    Given an old state file exists at "~/.claude/session-health/cooldowns/session-abc-transcript.state"
    And the old state contains:
      """
      {
        "lastReadOffset": 50000,
        "lastReadMtime": 1738876543000,
        "messageCount": 42,
        "lastUserMessage": {
          "timestamp": 1738876540000,
          "preview": "What does this do?"
        }
      }
      """
    When I load state for "session-abc"
    Then the state is migrated to new format
    And lastOffset equals 50000
    And lastMtime equals 1738876543000
    And extractorData.last_message.turnNumber equals 42
    And extractorData.last_message.preview equals "What does this do?"
    And a log message indicates migration

  Scenario: Migrate from GitLeaksScanner state
    Given an old state file exists at "~/.claude/session-health/cooldowns/session-abc-gitleaks.state"
    And the old state contains:
      """
      {
        "lastScannedOffset": 50000,
        "lastScannedMtime": 1738876543000,
        "knownFindings": ["github-pat-abc123", "aws-access-xyz789"]
      }
      """
    When I load state for "session-abc"
    Then the state is migrated to new format
    And lastOffset equals 50000
    And extractorData.secrets contains 2 fingerprints
    And a log message indicates migration

  Scenario: No state file exists and no old formats found
    Given no state file exists for "session-abc"
    And no old state files exist
    When I load state for "session-abc"
    Then null is returned
    And createInitial() is called to create fresh state

  # ============================================================================
  # SCENARIO GROUP: Extractors
  # ============================================================================

  Scenario: All extractors run in parallel
    Given 4 extractors are registered
    And a transcript has 100 new lines
    When I scan the transcript
    Then all 4 extractors receive the same ParsedLine array
    And all extractors start execution simultaneously
    And the total duration is max(extractor_durations), not sum

  Scenario: Extractor returns data successfully
    Given LastMessageExtractor is registered
    And the transcript contains a user message "How do I fix this?"
    When I scan the transcript
    Then the result.lastMessage.preview equals "How do I fix this?"
    And the result.lastMessage.sender equals "human"
    And the state.extractorData.last_message is cached

  Scenario: Extractor timeout uses cached fallback
    Given SlowExtractor is registered with 10s execution time
    And the scanner timeout is 5s
    And the state contains cached data for SlowExtractor
    When I scan the transcript
    Then the extractor is killed after 5s
    And the result uses cached data from state
    And an error is logged
    And the metrics show extractor duration = 5000ms

  Scenario: Extractor error uses cached fallback
    Given BrokenExtractor is registered
    And the extractor throws an error
    And the state contains cached data for BrokenExtractor
    When I scan the transcript
    Then the error is caught
    And the result uses cached data from state
    And an error is logged
    And the scan completes successfully

  Scenario: Extractor with no cached data returns null on error
    Given BrokenExtractor is registered
    And the extractor throws an error
    And no cached data exists in state
    When I scan the transcript
    Then the result.extractorData.broken is null
    And an error is logged
    And the scan completes successfully

  # ============================================================================
  # SCENARIO GROUP: LastMessageExtractor
  # ============================================================================

  Scenario: Extract last user message from transcript
    Given a transcript contains 50 messages
    And the last user message is "What does the main function do?"
    And the last user message is at turn 42
    When LastMessageExtractor runs
    Then the result.lastMessage.preview equals "What does the main function do?"
    And the result.lastMessage.turnNumber equals 42
    And the result.lastMessage.sender equals "human"
    And the result.lastMessage.timestamp is set

  Scenario: Extract text from string content format
    Given a user message with content: "Hello world"
    When LastMessageExtractor extracts text
    Then the preview equals "Hello world"

  Scenario: Extract text from array content format
    Given a user message with content:
      """
      [
        { "type": "text", "text": "What is this?" },
        { "type": "tool_result", "content": "..." }
      ]
      """
    When LastMessageExtractor extracts text
    Then the preview equals "What is this?"

  Scenario: Skip messages with no text content
    Given a user message with only tool_result content
    When LastMessageExtractor scans backward
    Then the message is skipped
    And the next user message with text is used

  Scenario: Truncate long message previews
    Given a user message with 200 characters
    When LastMessageExtractor generates preview
    Then the preview is truncated to 80 characters
    And the preview ends with ".."

  Scenario: Handle transcript with no user messages
    Given a transcript with only assistant messages
    When LastMessageExtractor runs
    Then the result.lastMessage.preview equals ""
    And the result.lastMessage.turnNumber equals 0
    And the result.lastMessage.sender equals "unknown"

  # ============================================================================
  # SCENARIO GROUP: SecretDetector
  # ============================================================================

  Scenario: Detect GitHub personal access token
    Given a transcript line contains "ghp_1234567890abcdefghijklmnopqrstuvwx"
    When SecretDetector runs
    Then 1 secret is detected
    And the secret.type equals "GitHub Token"
    And the secret.match equals "ghp_...vwx"
    And the secret.fingerprint is unique

  Scenario: Detect AWS access key
    Given a transcript line contains "AKIAIOSFODNN7EXAMPLE"
    When SecretDetector runs
    Then 1 secret is detected
    And the secret.type equals "AWS Key"

  Scenario: Detect private key
    Given a transcript line contains "-----BEGIN RSA PRIVATE KEY-----"
    When SecretDetector runs
    Then 1 secret is detected
    And the secret.type equals "Private Key"

  Scenario: Deduplicate secrets by fingerprint
    Given a secret "ghp_abc123" appears on line 10
    And the same secret appears on line 50
    When SecretDetector runs
    Then only 1 secret is detected
    And the fingerprint is the same for both occurrences

  Scenario: Redact secret values
    Given a secret "ghp_1234567890abcdefghijklmnopqrstuvwx" is detected
    When the secret is added to results
    Then the match field equals "ghp_...vwx" (first 4 + last 4)
    And the full secret is not stored

  Scenario: Handle transcript with no secrets
    Given a transcript with no secret patterns
    When SecretDetector runs
    Then the result.secrets is an empty array

  # ============================================================================
  # SCENARIO GROUP: CommandDetector (NEW)
  # ============================================================================

  Scenario: Detect /login command
    Given a transcript line contains "/login"
    When CommandDetector runs
    Then 1 command is detected
    And the command.command equals "/login"
    And the command.args is an empty array

  Scenario: Detect /swap-auth command with email
    Given a transcript line contains "/swap-auth user@example.com"
    When CommandDetector runs
    Then 1 command is detected
    And the command.command equals "/swap-auth"
    And the command.args contains ["user@example.com"]

  Scenario: Detect /clear command
    Given a transcript line contains "/clear"
    When CommandDetector runs
    Then 1 command is detected
    And the command.command equals "/clear"

  Scenario: Ignore non-command text starting with /
    Given a transcript line contains "/path/to/file.txt"
    When CommandDetector runs
    Then 0 commands are detected

  Scenario: Track command timestamps
    Given a /login command at timestamp 1738876500000
    When CommandDetector runs
    Then the command.timestamp equals 1738876500000

  # ============================================================================
  # SCENARIO GROUP: AuthChangeDetector (NEW)
  # ============================================================================

  Scenario: Detect login success message
    Given a transcript contains "/login"
    And the next line contains "Login successful for vladks.com"
    When AuthChangeDetector runs
    Then 1 auth change is detected
    And the authChange.email equals "vladks.com"
    And the authChange.loginTimestamp is set

  Scenario: Ignore login without success confirmation
    Given a transcript contains "/login"
    And no success message follows
    When AuthChangeDetector runs
    Then 0 auth changes are detected

  Scenario: Detect swap-auth success
    Given a transcript contains "/swap-auth rimidalvk@gmail.com"
    And the next line contains "Authentication switched to rimidalvk@gmail.com"
    When AuthChangeDetector runs
    Then 1 auth change is detected
    And the authChange.email equals "rimidalvk@gmail.com"

  # ============================================================================
  # SCENARIO GROUP: Parsing & Error Handling
  # ============================================================================

  Scenario: Parse valid JSONL lines
    Given transcript content:
      """
      {"type":"user","text":"hello"}
      {"type":"assistant","text":"hi"}
      """
    When LineParser parses the content
    Then 2 ParsedLine objects are returned
    And both have data populated
    And both have parseError=null

  Scenario: Handle malformed JSON lines
    Given transcript content:
      """
      {"type":"user","text":"hello"}
      {"invalid json
      {"type":"assistant","text":"hi"}
      """
    When LineParser parses the content
    Then 3 ParsedLine objects are returned
    And ParsedLine[0].data is populated
    And ParsedLine[1].data is null
    And ParsedLine[1].parseError is set
    And ParsedLine[2].data is populated

  Scenario: Skip empty lines
    Given transcript content:
      """
      {"type":"user","text":"hello"}

      {"type":"assistant","text":"hi"}
      """
    When LineParser parses the content
    Then 2 ParsedLine objects are returned
    And no empty lines are included

  Scenario: Handle completely empty file
    Given transcript content is empty
    When LineParser parses the content
    Then 0 ParsedLine objects are returned

  # ============================================================================
  # SCENARIO GROUP: File I/O & Edge Cases
  # ============================================================================

  Scenario: Handle non-existent transcript file
    Given no file exists at "/path/to/transcript.jsonl"
    When I scan the transcript
    Then an empty ScanResult is returned
    And the health.exists equals false
    And no error is thrown

  Scenario: Handle unreadable transcript file
    Given a file exists but is not readable
    When I scan the transcript
    Then an empty ScanResult is returned
    And an error is logged
    And no error is thrown

  Scenario: Handle file size exceeding limit
    Given a transcript file of 60MB (exceeds 50MB limit)
    When I scan the transcript
    Then an empty ScanResult is returned
    And a warning is logged
    And no error is thrown

  Scenario: Handle concurrent scans of same session
    Given a transcript file exists
    When I scan the transcript from 2 processes simultaneously
    Then both scans complete successfully
    And both write state atomically
    And no state corruption occurs

  # ============================================================================
  # SCENARIO GROUP: Performance
  # ============================================================================

  Scenario: Cache hit completes in <2ms
    Given a cached scan result exists
    When I scan the transcript
    Then the scan completes in less than 2ms

  Scenario: Incremental scan of 100 lines completes in <10ms
    Given a transcript with 100 new lines
    When I scan the transcript incrementally
    Then the scan completes in less than 10ms

  Scenario: Full scan of 1000 lines completes in <100ms
    Given a transcript with 1000 lines
    And no state exists
    When I scan the transcript
    Then the scan completes in less than 100ms

  Scenario: Full scan of 10000 lines completes in <500ms
    Given a transcript with 10000 lines
    And no state exists
    When I scan the transcript
    Then the scan completes in less than 500ms

  Scenario: Memory usage stays under 5MB per session
    Given a large transcript (10000 lines)
    When I scan the transcript
    Then peak memory usage is less than 5MB
    And no memory leaks occur

  # ============================================================================
  # SCENARIO GROUP: Validation & Security
  # ============================================================================

  Scenario: Reject sessionId with path traversal
    Given a sessionId of "../../../etc/passwd"
    When I scan the transcript
    Then an empty ScanResult is returned
    And no file operations are performed

  Scenario: Reject sessionId with invalid characters
    Given a sessionId of "session@#$%"
    When I scan the transcript
    Then an empty ScanResult is returned

  Scenario: Accept valid sessionId with alphanumeric and dashes
    Given a sessionId of "session-abc-123_test"
    When I scan the transcript
    Then the scan proceeds normally

  Scenario: Reject relative transcript path
    Given a transcriptPath of "transcript.jsonl" (relative)
    When I scan the transcript
    Then an empty ScanResult is returned

  Scenario: Accept absolute transcript path
    Given a transcriptPath of "/Users/user/.claude/sessions/abc/transcript.jsonl"
    When I scan the transcript
    Then the scan proceeds normally

  # ============================================================================
  # SCENARIO GROUP: Configuration
  # ============================================================================

  Scenario: Override default cache TTL
    Given I configure cacheTTL to 5000ms
    When I scan a transcript
    Then the cache expires after 5 seconds

  Scenario: Override default max file size
    Given I configure maxFileSize to 100_000_000 bytes
    When I scan a 60MB transcript
    Then the scan proceeds normally

  Scenario: Override default extractor timeout
    Given I configure extractorTimeout to 10000ms
    When an extractor runs for 8 seconds
    Then the extractor completes successfully

  # ============================================================================
  # SCENARIO GROUP: Metrics & Observability
  # ============================================================================

  Scenario: Metrics include scan duration
    Given a transcript is scanned
    When I inspect the metrics
    Then metrics.scanDuration is populated
    And the value represents total milliseconds

  Scenario: Metrics include lines scanned
    Given a transcript with 100 new lines
    When I scan the transcript
    Then metrics.linesScanned equals 100

  Scenario: Metrics include bytes read
    Given a transcript with 10000 new bytes
    When I scan the transcript
    Then metrics.bytesRead equals 10000

  Scenario: Metrics include per-extractor durations
    Given 3 extractors are registered
    When I scan the transcript
    Then metrics.extractorDurations contains 3 entries
    And each entry shows milliseconds taken

  Scenario: Metrics track cache hit status
    Given a cached scan result
    When I scan the transcript
    Then metrics.cacheHit equals true

  # ============================================================================
  # SCENARIO GROUP: Health Metrics
  # ============================================================================

  Scenario: Health metrics show file exists
    Given a transcript file exists
    When I scan the transcript
    Then health.exists equals true

  Scenario: Health metrics show last modified time
    Given a transcript modified 5 minutes ago
    When I scan the transcript
    Then health.lastModifiedAgo equals "5m"

  Scenario: Health metrics show file size
    Given a transcript of 50000 bytes
    When I scan the transcript
    Then health.sizeBytes equals 50000

  Scenario: Health metrics show message count
    Given a transcript with 42 messages
    When I scan the transcript
    Then health.messageCount equals 42

  # ============================================================================
  # SCENARIO GROUP: Cache Management
  # ============================================================================

  Scenario: Cache evicts oldest entries when full
    Given 100 sessions are cached
    And cache limit is 100 entries
    When I scan a 101st session
    Then the oldest cache entry is evicted
    And the new entry is cached

  Scenario: Cache cleanup removes expired entries
    Given 10 sessions are cached
    And 5 entries have expired
    When cleanup() is called
    Then 5 entries are removed
    And 5 entries remain

  Scenario: Cache invalidation removes specific session
    Given "session-abc" is cached
    When I invalidate "session-abc"
    Then the cache no longer contains "session-abc"
    And other cached sessions remain

  # ============================================================================
  # SCENARIO GROUP: Integration
  # ============================================================================

  Scenario: Full end-to-end scan flow
    Given a new session "session-xyz"
    And a transcript with 100 lines
    When I scan the transcript
    Then IncrementalReader reads all 100 lines
    And LineParser parses 100 JSONL objects
    And all extractors run in parallel
    And StateManager saves state to disk
    And ResultCache stores result in memory
    And a valid ScanResult is returned

  Scenario: Incremental updates across multiple scans
    Given a transcript with 100 lines
    And I scan the transcript
    And 50 new lines are added
    When I scan the transcript again
    Then only 50 new lines are processed
    And the state reflects 150 total offset
    And extractor data is updated

  Scenario: State persistence across process restarts
    Given I scan a transcript in process A
    And process A exits
    When I scan the same transcript in process B
    Then the state is loaded from disk
    And only new content is processed

  # ============================================================================
  # SCENARIO GROUP: Backward Compatibility
  # ============================================================================

  Scenario: Replace IncrementalTranscriptScanner transparently
    Given data-gatherer.ts uses IncrementalTranscriptScanner
    When I replace it with UnifiedTranscriptScanner
    Then the same TranscriptHealth interface is returned
    And no breaking changes occur

  Scenario: Coexist with old modules during migration
    Given IncrementalTranscriptScanner is still in use
    And UnifiedTranscriptScanner is deployed
    When both scan the same session
    Then both use separate state files
    And no conflicts occur

# ============================================================================
# Test Coverage Summary
# ============================================================================

# Total Scenarios: 95
# Coverage Areas:
# - Cache behavior: 3 scenarios
# - Incremental scanning: 5 scenarios
# - State management: 4 scenarios
# - Migration: 3 scenarios
# - Extractors: 6 scenarios
# - LastMessageExtractor: 6 scenarios
# - SecretDetector: 6 scenarios
# - CommandDetector: 5 scenarios (NEW)
# - AuthChangeDetector: 3 scenarios (NEW)
# - Parsing & error handling: 4 scenarios
# - File I/O & edge cases: 4 scenarios
# - Performance: 5 scenarios
# - Validation & security: 5 scenarios
# - Configuration: 3 scenarios
# - Metrics & observability: 5 scenarios
# - Health metrics: 4 scenarios
# - Cache management: 3 scenarios
# - Integration: 3 scenarios
# - Backward compatibility: 2 scenarios

# Success Criteria:
# - All scenarios must pass
# - No scenario should be skipped
# - Performance targets must be met
# - No memory leaks
# - No security vulnerabilities
