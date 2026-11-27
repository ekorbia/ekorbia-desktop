//! Saving a Word document (.docx).
//!
//! A .docx is a zip of XML parts. The UI writes the three parts that depend
//! on what is being saved (the document, its styles, its list numbering —
//! `docxParts` in ui/utils.js, built from the same Markdown tokens the chat
//! view renders); this module adds the three fixed parts that tie a package
//! together and writes the zip. The zip is written "stored" (uncompressed):
//! that is valid for a .docx, needs no compression crate, and these files
//! are small.
//!
//! The command writes only to the path the person chose in the save dialog,
//! refuses a path that does not end in `.docx`, and always writes a .docx
//! package: it cannot be used to put arbitrary bytes somewhere.

use serde::Deserialize;

/// Upper bound on one part. A long chat is a few hundred kilobytes of XML;
/// this only stops a runaway.
const MAX_PART_BYTES: usize = 32 * 1024 * 1024;

const CONTENT_TYPES: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
    r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
    r#"<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>"#,
    r#"<Default Extension="xml" ContentType="application/xml"/>"#,
    r#"<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>"#,
    r#"<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>"#,
    r#"<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>"#,
    r#"</Types>"#,
);

const ROOT_RELS: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>"#,
    r#"</Relationships>"#,
);

const DOCUMENT_RELS: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#,
    r#"<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>"#,
    r#"</Relationships>"#,
);

/// The parts the UI supplies, each a complete XML file.
#[derive(Deserialize)]
pub(crate) struct DocxParts {
    document: String,
    styles: String,
    numbering: String,
}

/// CRC-32 (the zip one: reflected, polynomial 0xEDB88320).
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// A zip archive of `files` (name, contents), every entry stored as is.
/// Names are ASCII paths with forward slashes. The date is fixed (1 Jan
/// 1980, the earliest a zip can say) so the same input gives the same bytes.
fn stored_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    const DOS_TIME: u16 = 0;
    const DOS_DATE: u16 = 0x0021;
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, data) in files {
        let offset = out.len() as u32;
        let crc = crc32(data);
        let size = data.len() as u32;
        let name_len = name.len() as u16;

        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // method: stored
        out.extend_from_slice(&DOS_TIME.to_le_bytes());
        out.extend_from_slice(&DOS_DATE.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes()); // compressed size
        out.extend_from_slice(&size.to_le_bytes()); // real size
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra length
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0u16.to_le_bytes()); // flags
        central.extend_from_slice(&0u16.to_le_bytes()); // method
        central.extend_from_slice(&DOS_TIME.to_le_bytes());
        central.extend_from_slice(&DOS_DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&name_len.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra length
        central.extend_from_slice(&0u16.to_le_bytes()); // comment length
        central.extend_from_slice(&0u16.to_le_bytes()); // disk number
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
        central.extend_from_slice(&0u32.to_le_bytes()); // external attributes
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset = out.len() as u32;
    let central_size = central.len() as u32;
    let count = files.len() as u16;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // this disk
    out.extend_from_slice(&0u16.to_le_bytes()); // disk with the directory
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment length
    out
}

/// A part must be an XML file whose root is the one expected: this is a
/// check that the right string went in the right slot, not a validation.
fn check_part(name: &str, xml: &str, root: &str) -> Result<(), String> {
    if xml.len() > MAX_PART_BYTES {
        return Err(format!("the {name} is too large to save"));
    }
    if !xml.starts_with("<?xml") || !xml.contains(root) {
        return Err(format!("the {name} part is not what was expected"));
    }
    Ok(())
}

/// The bytes of a .docx made of `parts`.
fn package(parts: &DocxParts) -> Result<Vec<u8>, String> {
    check_part("document", &parts.document, "<w:document")?;
    check_part("styles", &parts.styles, "<w:styles")?;
    check_part("numbering", &parts.numbering, "<w:numbering")?;
    Ok(stored_zip(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("word/document.xml", parts.document.as_bytes()),
        ("word/_rels/document.xml.rels", DOCUMENT_RELS.as_bytes()),
        ("word/styles.xml", parts.styles.as_bytes()),
        ("word/numbering.xml", parts.numbering.as_bytes()),
    ]))
}

fn is_docx_path(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("docx"))
}

/// Write a Word document to `path`, the file the person chose in the save
/// dialog.
#[tauri::command]
pub(crate) fn docx_save(path: String, parts: DocxParts) -> Result<(), String> {
    if !is_docx_path(&path) {
        return Err("a Word document's name must end in .docx".into());
    }
    let bytes = package(&parts)?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> DocxParts {
        DocxParts {
            document: r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fees are fixed at £4,500.</w:t></w:r></w:p></w:body></w:document>"#.into(),
            styles: r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>"#.into(),
            numbering: r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>"#.into(),
        }
    }

    /// Walk a stored zip from its end record, returning (name, contents)
    /// and checking each entry's sizes and checksum on the way.
    fn read_stored_zip(zip: &[u8]) -> Vec<(String, Vec<u8>)> {
        let u16_at = |i: usize| u16::from_le_bytes([zip[i], zip[i + 1]]) as usize;
        let u32_at =
            |i: usize| u32::from_le_bytes([zip[i], zip[i + 1], zip[i + 2], zip[i + 3]]) as usize;
        let end = zip.len() - 22;
        assert_eq!(u32_at(end), 0x0605_4b50, "end record");
        let count = u16_at(end + 10);
        let mut at = u32_at(end + 16);
        assert_eq!(
            at + u32_at(end + 12),
            end,
            "the directory runs to the end record"
        );
        let mut out = Vec::new();
        for _ in 0..count {
            assert_eq!(u32_at(at), 0x0201_4b50, "directory entry");
            assert_eq!(u16_at(at + 10), 0, "stored");
            let crc = u32_at(at + 16) as u32;
            let size = u32_at(at + 24);
            let name_len = u16_at(at + 28);
            let local = u32_at(at + 42);
            let name = String::from_utf8(zip[at + 46..at + 46 + name_len].to_vec()).unwrap();
            assert_eq!(u32_at(local), 0x0403_4b50, "local header");
            assert_eq!(u32_at(local + 14) as u32, crc);
            assert_eq!(u32_at(local + 18), size);
            assert_eq!(u32_at(local + 22), size);
            let local_name_len = u16_at(local + 26);
            assert_eq!(
                &zip[local + 30..local + 30 + local_name_len],
                name.as_bytes()
            );
            let start = local + 30 + local_name_len + u16_at(local + 28);
            let data = zip[start..start + size].to_vec();
            assert_eq!(crc32(&data), crc, "checksum of {name}");
            out.push((name, data));
            at += 46 + name_len;
        }
        out
    }

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn the_package_holds_the_six_parts_and_reads_back() {
        let parts = sample();
        let files = read_stored_zip(&package(&parts).unwrap());
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "[Content_Types].xml",
                "_rels/.rels",
                "word/document.xml",
                "word/_rels/document.xml.rels",
                "word/styles.xml",
                "word/numbering.xml",
            ]
        );
        // Text outside ASCII survives as UTF-8.
        assert_eq!(files[2].1, parts.document.as_bytes());
        assert!(String::from_utf8(files[2].1.clone())
            .unwrap()
            .contains("£4,500"));
    }

    #[test]
    fn every_part_in_the_package_is_declared_and_related() {
        // A part Word is not told about is a "corrupt file" dialog.
        for part in [
            "/word/document.xml",
            "/word/styles.xml",
            "/word/numbering.xml",
        ] {
            assert!(CONTENT_TYPES.contains(part), "{part} has no content type");
        }
        assert!(ROOT_RELS.contains(r#"Target="word/document.xml""#));
        assert!(DOCUMENT_RELS.contains(r#"Target="styles.xml""#));
        assert!(DOCUMENT_RELS.contains(r#"Target="numbering.xml""#));
    }

    #[test]
    fn the_same_parts_give_the_same_bytes() {
        assert_eq!(package(&sample()).unwrap(), package(&sample()).unwrap());
    }

    #[test]
    fn a_part_in_the_wrong_slot_is_refused() {
        let mut parts = sample();
        parts.styles = parts.numbering.clone();
        assert!(package(&parts).is_err());
        let mut parts = sample();
        parts.document = "not xml".into();
        assert!(package(&parts).is_err());
    }

    #[test]
    fn only_a_docx_path_is_written() {
        assert!(is_docx_path("/Users/x/Letter.docx"));
        assert!(is_docx_path("/Users/x/Letter.DOCX"));
        assert!(!is_docx_path("/Users/x/.zshrc"));
        assert!(!is_docx_path("/Users/x/Letter.docx.sh"));
        assert!(!is_docx_path("/Users/x/docx"));
        assert_eq!(
            docx_save("/tmp/ekorbia-not-a-document.txt".into(), sample()),
            Err("a Word document's name must end in .docx".into())
        );
    }

    #[test]
    fn saving_writes_a_package_to_the_path() {
        let path =
            std::env::temp_dir().join(format!("ekorbia-docx-test-{}.docx", std::process::id()));
        let path_str = path.to_string_lossy().to_string();
        docx_save(path_str, sample()).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_stored_zip(&bytes).len(), 6);
    }

    /// Manual check, not part of the suite: package real parts written by
    /// the UI's `docxParts` and open the result in Word, Pages or
    /// `textutil -convert txt`. Reads DOCX_DOCUMENT / DOCX_STYLES /
    /// DOCX_NUMBERING (paths to the three XML files), writes DOCX_OUT.
    #[test]
    #[ignore]
    fn package_parts_from_files() {
        let read = |var: &str| std::fs::read_to_string(std::env::var(var).unwrap()).unwrap();
        let parts = DocxParts {
            document: read("DOCX_DOCUMENT"),
            styles: read("DOCX_STYLES"),
            numbering: read("DOCX_NUMBERING"),
        };
        docx_save(std::env::var("DOCX_OUT").unwrap(), parts).unwrap();
    }
}
