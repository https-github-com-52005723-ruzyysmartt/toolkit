import * as assert from 'assert'
import * as path from 'path'
import * as pathHelper from './internal-path-helper'
import {Minimatch, IMinimatch, IOptions as IMinimatchOptions} from 'minimatch'
import {MatchKind} from './internal-match-kind'
import {Path} from './internal-path'

const IS_WINDOWS = process.platform === 'win32'

export class Pattern {
  negate: boolean = false
  searchPath: string
  private minimatch: IMinimatch
  private rootRegExp: RegExp
  private trailingSlash: boolean

  constructor(pattern: string) {
    pattern = pattern || ''

    // Negate
    while (pattern.startsWith('!')) {
      this.negate = !this.negate
      pattern = pattern.substr(1)
    }

    // Normalize slashes and ensure rooted
    pattern = this.fixupPattern(pattern)

    // Trailing slash indicates the pattern should only match directories, not regular files
    this.trailingSlash = pathHelper
      .normalizeSeparators(pattern)
      .endsWith(path.sep)
    pattern = pathHelper.safeTrimTrailingSeparator(pattern)

    // Search path
    const searchSegments = this.getLiterals(pattern, true)
    this.searchPath = new Path(searchSegments).toString()

    // Root RegExp (required when determining partial match)
    this.rootRegExp = new RegExp(
      this.regExpEscape(searchSegments[0]),
      IS_WINDOWS ? 'i' : ''
    )

    // Create minimatch
    const minimatchOptions: IMinimatchOptions = {
      dot: true,
      nobrace: true,
      nocase: IS_WINDOWS,
      nocomment: true,
      noext: true,
      nonegate: true
    }
    pattern = IS_WINDOWS ? pattern.replace(/\\/g, '/') : pattern
    this.minimatch = new Minimatch(pattern, minimatchOptions)
  }

  /**
   * Matches the pattern against the specified path
   */
  match(itemPath: string): MatchKind {
    if (this.minimatch.match(itemPath)) {
      return this.trailingSlash ? MatchKind.Directory : MatchKind.All
    }

    return MatchKind.None
  }

  /**
   * Indicates whether the pattern may match descendants of the specified path
   */
  partialMatch(itemPath: string): boolean {
    // matchOne does not handle root path correctly
    if (pathHelper.dirname(itemPath) === itemPath) {
      return this.rootRegExp.test(itemPath)
    }

    return this.minimatch.matchOne(
      itemPath.split(/\/+/),
      this.minimatch.set[0],
      true
    )
  }

  /**
   * Normalizes slashes and ensures rooted
   */
  private fixupPattern(pattern: string): string {
    // Empty
    assert(pattern, 'pattern cannot be empty')

    // Must not use C: and C:foo format on Windows (for simplicity)
    const literalSegments = this.getLiterals(pattern)
    assert(
      !IS_WINDOWS || !/^[A-Z]:$/i.test(literalSegments[0]),
      `The pattern '${pattern}' uses an unsupported root-directory prefix. When a drive letter is specified, use absolute path syntax.`
    )

    // Must not be `.` unless first segment
    // Must not be `..`
    assert(
      literalSegments.every((x, i) => (x !== '.' || i === 0) && x !== '..'),
      `Invalid pattern '${pattern}'. Relative pathing '.' and '..' is not allowed.`
    )

    // Must not contain globs in root, e.g. \\foo\b*
    assert(
      literalSegments[0] || !pathHelper.isRooted(pattern),
      `Invalid pattern '${pattern}'. Root segment must not contain globs`
    )

    // Normalize slashes
    pattern = pathHelper.normalizeSeparators(pattern)

    // Replace leading `.` segment
    if (pattern === '.' || pattern.startsWith(`.${path.sep}`)) {
      pattern = this.globEscape(process.cwd()) + pattern.substr(1)
      pattern = pathHelper.normalizeSeparators(pattern)
    }

    // Root the pattern
    if (!pathHelper.isRooted(pattern)) {
      pattern = pathHelper.ensureRooted(this.globEscape(process.cwd()), pattern)
    }

    return pattern
  }

  /**
   * Splits a pattern into segments and attempts to unescape each segment to create a
   * literal segment. Otherwise creates an empty segment.
   * @param pattern        The pattern
   * @param stopWhenEmpty  Indicates whether to only include segments prior to the first
   *                       empty segment (empty indicates failure to convert to literal)
   */
  private getLiterals(
    pattern: string,
    stopWhenEmpty: boolean = false
  ): string[] {
    // All
    const literals = new Path(pattern).segments.map(x => this.getLiteral(x))
    if (!stopWhenEmpty) {
      return literals
    }

    // Filtered
    const result: string[] = []
    for (const literal of literals) {
      if (!literal) {
        break
      }
      result.push(literal)
    }
    return result
  }

  /**
   * Attempts to unescape a pattern segment to create a literal path segment.
   * Otherwise returns empty string.
   */
  private getLiteral(segment: string): string {
    let literal = ''
    for (let i = 0; i < segment.length; i++) {
      const c = segment[i]
      // Escape
      if (c === '\\' && !IS_WINDOWS && i + 1 < segment.length) {
        literal += segment[++i]
        continue
      }
      // Wildcard
      else if (c === '*' || c === '?') {
        return ''
      }
      // Character set
      else if (c === '[' && i + 1 < segment.length) {
        let set = ''
        let closed = -1
        for (let i2 = i + 1; i2 < segment.length; i2++) {
          const c2 = segment[i2]
          // Escape
          if (c2 === '\\' && !IS_WINDOWS && i2 + 1 < segment.length) {
            set += segment[++i2]
            continue
          }
          // Closed
          else if (c2 === ']') {
            closed = i2
            break
          }
          // Otherwise
          else {
            set += c2
          }
        }

        // Closed?
        if (closed >= 0) {
          // Cannot convert
          if (set.length > 1 || set === '!') {
            return ''
          }

          // Convert to literal
          literal += set
          i = closed
          continue
        }

        // Otherwise fall thru
      }

      // Append
      literal += c
    }

    return literal
  }

  /**
   * Escapes glob patterns within a path
   */
  private globEscape(s: string): string {
    return (IS_WINDOWS ? s : s.replace(/\\/g, '\\\\')) // escape '\' on Linux/macOS
      .replace(/(\[)(?=[^/]+\])/g, '[[]') // escape '[' when ']' follows within the path segment
      .replace(/\?/g, '[?]') // escape '?'
      .replace(/\*/g, '[*]') // escape '*'
  }

  /**
   * Escapes regexp special characters
   * https://javascript.info/regexp-escaping
   */
  private regExpEscape(s: string): string {
    return s.replace(/[[\\^$.|?*+()]/g, '\\$&')
  }
}
