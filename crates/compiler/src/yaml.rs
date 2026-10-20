//! A small, deterministic YAML emitter for `apm.yml`.
//!
//! The manifest is built as a [`Node`] tree whose maps keep the order they
//! were built in, then written by [`render`]. The output is the same bytes on
//! every platform and in WASM: block style throughout, two-space indentation,
//! `- ` list items, one trailing line feed, and a string written plain only
//! when no YAML 1.1 or 1.2 reader could take it for anything but that string.
//! Everything else is double-quoted with JSON-style escapes.
//!
//! A YAML library would do, but none of them promise their quoting and
//! layout across versions, and the emitted bytes are what the golden files,
//! `--frozen`, and the composer preview compare.

use std::fmt::Write as _;

/// A YAML value. Maps are ordered lists of entries, so the emitter writes keys
/// in the order the compiler chose.
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Null,
    Bool(bool),
    /// A number, kept as the text it was written as.
    Number(String),
    String(String),
    Seq(Vec<Node>),
    Map(Vec<(String, Node)>),
}

impl Node {
    pub fn string(value: impl Into<String>) -> Self {
        Self::String(value.into())
    }

    pub fn strings<I, S>(values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::Seq(values.into_iter().map(Self::string).collect())
    }

    /// The value under `key`, when this is a map that has it.
    pub fn get(&self, key: &str) -> Option<&Node> {
        match self {
            Self::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    /// The JSON form of this value, for schema validation and for callers
    /// that compare manifests structurally.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Self::Null => serde_json::Value::Null,
            Self::Bool(value) => serde_json::Value::Bool(*value),
            Self::Number(text) => serde_json::from_str::<serde_json::Number>(text)
                .map(serde_json::Value::Number)
                .unwrap_or_else(|_| serde_json::Value::String(text.clone())),
            Self::String(value) => serde_json::Value::String(value.clone()),
            Self::Seq(items) => serde_json::Value::Array(items.iter().map(Self::to_json).collect()),
            Self::Map(entries) => serde_json::Value::Object(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), value.to_json()))
                    .collect(),
            ),
        }
    }

    /// A JSON value as a node. Object keys come out in `serde_json`'s order,
    /// which is sorted, so the result does not depend on how the JSON was
    /// written.
    pub fn from_json(value: &serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Self::Null,
            serde_json::Value::Bool(value) => Self::Bool(*value),
            serde_json::Value::Number(number) => Self::Number(number.to_string()),
            serde_json::Value::String(value) => Self::String(value.clone()),
            serde_json::Value::Array(items) => {
                Self::Seq(items.iter().map(Self::from_json).collect())
            }
            serde_json::Value::Object(map) => Self::Map(
                map.iter()
                    .map(|(key, value)| (key.clone(), Self::from_json(value)))
                    .collect(),
            ),
        }
    }

    /// Parse a YAML document into a node, keeping its key order. Anchors and
    /// aliases are expanded by the parser; custom tags and non-string keys are
    /// refused, as OpenAPM's safe subset requires.
    pub fn parse(text: &str) -> Result<Self, String> {
        let value: serde_yaml::Value = serde_yaml::from_str(text).map_err(|e| e.to_string())?;
        Self::from_yaml(&value)
    }

    fn from_yaml(value: &serde_yaml::Value) -> Result<Self, String> {
        Ok(match value {
            serde_yaml::Value::Null => Self::Null,
            serde_yaml::Value::Bool(value) => Self::Bool(*value),
            serde_yaml::Value::Number(number) => Self::Number(number.to_string()),
            serde_yaml::Value::String(value) => Self::String(value.clone()),
            serde_yaml::Value::Sequence(items) => Self::Seq(
                items
                    .iter()
                    .map(Self::from_yaml)
                    .collect::<Result<_, _>>()?,
            ),
            serde_yaml::Value::Mapping(mapping) => {
                let mut entries = Vec::with_capacity(mapping.len());
                for (key, value) in mapping {
                    let Some(key) = key.as_str() else {
                        return Err(format!("mapping keys must be strings, found {key:?}"));
                    };
                    entries.push((key.to_owned(), Self::from_yaml(value)?));
                }
                Self::Map(entries)
            }
            serde_yaml::Value::Tagged(tagged) => {
                return Err(format!("custom tag `{}` is not allowed", tagged.tag));
            }
        })
    }
}

/// Write a document. A map at the top level is the only shape a manifest
/// takes; anything else is written as a single block value.
pub fn render(node: &Node) -> String {
    let mut out = String::new();
    match node {
        Node::Map(entries) if !entries.is_empty() => write_map(&mut out, entries, 0),
        Node::Seq(items) if !items.is_empty() => write_seq(&mut out, items, 0),
        scalar => {
            out.push_str(&inline(scalar));
            out.push('\n');
        }
    }
    out
}

fn write_map(out: &mut String, entries: &[(String, Node)], indent: usize) {
    for (key, value) in entries {
        pad(out, indent);
        out.push_str(&scalar(key));
        out.push(':');
        write_value(out, value, indent);
    }
}

fn write_seq(out: &mut String, items: &[Node], indent: usize) {
    for item in items {
        match item {
            Node::Map(entries) if !entries.is_empty() => {
                // The first entry shares the line with `- `; the rest line up
                // under it, two columns in.
                let mut nested = String::new();
                write_map(&mut nested, entries, indent + 2);
                pad(out, indent);
                out.push_str("- ");
                out.push_str(&nested[indent + 2..]);
            }
            Node::Seq(inner) if !inner.is_empty() => {
                let mut nested = String::new();
                write_seq(&mut nested, inner, indent + 2);
                pad(out, indent);
                out.push_str("- ");
                out.push_str(&nested[indent + 2..]);
            }
            scalar => {
                pad(out, indent);
                out.push_str("- ");
                out.push_str(&inline(scalar));
                out.push('\n');
            }
        }
    }
}

/// The value after `key:`, which is on the same line for a scalar or an
/// empty collection, and on the lines below for anything else.
fn write_value(out: &mut String, value: &Node, indent: usize) {
    match value {
        Node::Map(entries) if !entries.is_empty() => {
            out.push('\n');
            write_map(out, entries, indent + 2);
        }
        Node::Seq(items) if !items.is_empty() => {
            out.push('\n');
            write_seq(out, items, indent + 2);
        }
        scalar => {
            out.push(' ');
            out.push_str(&inline(scalar));
            out.push('\n');
        }
    }
}

fn inline(node: &Node) -> String {
    match node {
        Node::Null => "null".to_owned(),
        Node::Bool(value) => value.to_string(),
        Node::Number(text) => text.clone(),
        Node::String(value) => scalar(value),
        Node::Seq(_) => "[]".to_owned(),
        Node::Map(_) => "{}".to_owned(),
    }
}

fn pad(out: &mut String, indent: usize) {
    out.extend(std::iter::repeat_n(' ', indent));
}

/// Words a YAML 1.1 reader resolves to a boolean or null.
const RESERVED: &[&str] = &[
    "y", "yes", "n", "no", "true", "false", "on", "off", "null", "~",
];

/// A string, plain when that is unambiguous, otherwise double-quoted.
pub fn scalar(value: &str) -> String {
    if is_plain(value) {
        value.to_owned()
    } else {
        quoted(value)
    }
}

/// Plain only for a conservative alphabet: letters, digits, the punctuation
/// `_ . / @ $ + = ^ - #`, and single interior spaces, with no `#` after a
/// space (which would start a comment). It must start with a letter, a digit,
/// `_`, `/`, or `./`/`../`, must not be a reserved word, and must not read as
/// a number in either YAML version.
fn is_plain(value: &str) -> bool {
    let Some(first) = value.chars().next() else {
        return false;
    };
    let starts_well = first.is_ascii_alphanumeric()
        || first == '_'
        || first == '/'
        || value.starts_with("./")
        || value.starts_with("../");
    let alphabet = value.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(
                c,
                '_' | '.' | '/' | '@' | '$' | '+' | '=' | '^' | '-' | '#' | ' '
            )
    });
    starts_well
        && alphabet
        && !value.ends_with(' ')
        && !value.contains("  ")
        && !value.contains(" #")
        && !RESERVED.contains(&value.to_ascii_lowercase().as_str())
        && !looks_numeric(value)
}

/// Anything that starts with a digit and uses only characters a YAML number
/// can contain (`0x1F`, `1_000`, `1e3`, `0.0.0`, `0o17`, `0b1`) is quoted,
/// which costs a pair of quotes on some strings that are not numbers, such
/// as a bare commit hash.
fn looks_numeric(value: &str) -> bool {
    value.starts_with(|c: char| c.is_ascii_digit())
        && value.chars().all(|c| {
            c.is_ascii_hexdigit() || matches!(c, '.' | '_' | '+' | '-' | 'x' | 'X' | 'o' | 'O')
        })
}

fn quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || c == '\u{7f}' || is_yaml_break(c) => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Characters YAML treats as line breaks or that a reader may strip.
fn is_yaml_break(c: char) -> bool {
    matches!(c, '\u{85}' | '\u{2028}' | '\u{2029}' | '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(entries: &[(&str, Node)]) -> Node {
        Node::Map(
            entries
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        )
    }

    #[test]
    fn writes_block_style_in_the_order_given() {
        let doc = map(&[
            ("name", Node::string("app")),
            ("version", Node::string("1.0.0")),
            ("targets", Node::strings(["claude", "copilot"])),
            (
                "dependencies",
                map(&[
                    ("apm", Node::strings(["o/r/x.prompt.md#v1", "./vendor/app"])),
                    (
                        "mcp",
                        Node::Seq(vec![map(&[
                            ("name", Node::string("ctx")),
                            ("registry", Node::Bool(false)),
                            ("args", Node::Seq(vec![])),
                            ("env", map(&[("A", Node::string("${A}"))])),
                        ])]),
                    ),
                ]),
            ),
        ]);
        assert_eq!(
            render(&doc),
            "name: app\n\
             version: \"1.0.0\"\n\
             targets:\n  - claude\n  - copilot\n\
             dependencies:\n  apm:\n    - o/r/x.prompt.md#v1\n    - ./vendor/app\n  \
             mcp:\n    - name: ctx\n      registry: false\n      args: []\n      env:\n        A: \"${A}\"\n"
        );
    }

    #[test]
    fn quotes_what_a_reader_could_misread() {
        for value in [
            "",
            "yes",
            "No",
            "null",
            "~",
            "1.0",
            "0.0.0",
            "1e3",
            "0x1F",
            "-y",
            "@scope/pkg",
            ".ts",
            "a: b",
            "a #b",
            "#x",
            "[x]",
            "{x}",
            "x,y",
            " lead",
            "trail ",
            "a\nb",
            "*x",
            "&x",
            "!x",
            "%x",
            "|",
            ">",
            "'x'",
            "\"x\"",
            "`x`",
            "? x",
            "=x",
            "+1",
        ] {
            let text = scalar(value);
            assert!(
                text.starts_with('"'),
                "{value:?} should be quoted, got {text}"
            );
        }
        for value in [
            "claude",
            "io.github.upstash/context7",
            "anthropics/skills/skills/frontend-design#0123456789abcdef",
            "./vendor/x",
            "o/r#a@b",
            "Write a PR description",
            "typescript-language-server",
            "/abs/path",
        ] {
            assert_eq!(scalar(value), value, "{value:?} should be plain");
        }
    }

    #[test]
    fn every_string_reads_back_as_itself() {
        let tricky = [
            "",
            "yes",
            "1.0",
            "0.0.0",
            "a: b",
            "a #b",
            "tab\there",
            "line\nbreak",
            "quote\"d",
            "back\\slash",
            "unicode é ✓",
            "\u{2028}",
            "\u{1}",
            "${VAR}",
            "Bearer ${TOKEN}",
            "@playwright/mcp@latest",
            "-y",
            ".ts",
            "~",
            "null",
            "0o17",
            "x=1",
        ];
        let doc = Node::Map(
            tricky
                .iter()
                .enumerate()
                .map(|(i, value)| (format!("k{i}"), Node::string(*value)))
                .chain(std::iter::once((
                    "list".to_owned(),
                    Node::strings(tricky.iter().copied()),
                )))
                .collect(),
        );
        let text = render(&doc);
        assert_eq!(Node::parse(&text).unwrap(), doc, "{text}");
    }

    #[test]
    fn keys_are_quoted_like_values() {
        let doc = map(&[(
            "extensionToLanguage",
            map(&[(".ts", Node::string("typescript"))]),
        )]);
        assert_eq!(
            render(&doc),
            "extensionToLanguage:\n  \".ts\": typescript\n"
        );
    }

    #[test]
    fn nested_lists_and_maps_inside_lists_line_up() {
        let doc = map(&[(
            "x",
            Node::Seq(vec![
                map(&[("a", Node::strings(["1"])), ("b", Node::Null)]),
                Node::Seq(vec![Node::string("p"), Node::string("q")]),
            ]),
        )]);
        let text = render(&doc);
        assert_eq!(
            text,
            "x:\n  - a:\n      - \"1\"\n    b: null\n  - - p\n    - q\n"
        );
        assert_eq!(Node::parse(&text).unwrap(), doc);
    }

    #[test]
    fn custom_tags_are_refused() {
        assert!(Node::parse("a: !secret x\n").is_err());
    }
}
