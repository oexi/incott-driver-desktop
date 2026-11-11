//! HID 报告描述符解析：得到 WebHID 风格的 collections（诊断信息要用），以及每个报告的字节数（收发时按它分配缓冲区）。
//! 只解析顶层集合；嵌套集合里的报告都算在它所属的顶层集合下。

use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReportItem {
    pub report_size: u32,
    pub report_count: u32,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReportInfo {
    pub report_id: u8,
    pub items: Vec<ReportItem>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub usage_page: u16,
    pub usage: u16,
    #[serde(rename = "type")]
    pub kind: u8,
    pub children: Vec<CollectionInfo>,
    pub input_reports: Vec<ReportInfo>,
    pub output_reports: Vec<ReportInfo>,
    pub feature_reports: Vec<ReportInfo>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Kind {
    Input,
    Output,
    Feature,
}

#[derive(Clone, Debug, Default)]
pub struct Parsed {
    pub collections: Vec<CollectionInfo>,
    /// 描述符里出现过 Report ID：收发的数据第 0 字节是报告 ID
    pub numbered: bool,
    /// 每个报告的字节数（不含报告 ID）
    pub sizes: HashMap<(Kind, u8), usize>,
}

impl Parsed {
    pub fn size(&self, kind: Kind, id: u8) -> Option<usize> {
        self.sizes.get(&(kind, id)).copied()
    }

    pub fn max_size(&self, kind: Kind) -> Option<usize> {
        self.sizes.iter().filter(|((k, _), _)| *k == kind).map(|(_, v)| *v).max()
    }
}

#[derive(Clone, Copy, Default)]
struct Globals {
    usage_page: u32,
    report_size: u32,
    report_count: u32,
    report_id: u8,
}

fn add_item(list: &mut Vec<ReportInfo>, id: u8, item: ReportItem) {
    match list.iter_mut().find(|r| r.report_id == id) {
        Some(r) => r.items.push(item),
        None => list.push(ReportInfo { report_id: id, items: vec![item] }),
    }
}

pub fn parse(desc: &[u8]) -> Parsed {
    let mut out = Parsed::default();
    let mut bits: HashMap<(Kind, u8), u64> = HashMap::new();
    let mut g = Globals::default();
    let mut stack: Vec<Globals> = Vec::new();
    let mut usages: Vec<u32> = Vec::new();
    let mut depth = 0usize;
    let mut i = 0usize;

    while i < desc.len() {
        let prefix = desc[i];
        // 长条目：0xFE, 长度, 标签, 数据……，HID 规范里没有定义任何长条目，跳过
        if prefix == 0xfe {
            let len = desc.get(i + 1).copied().unwrap_or(0) as usize;
            i += 3 + len;
            continue;
        }
        let size = match prefix & 3 {
            3 => 4,
            n => n as usize,
        };
        if i + 1 + size > desc.len() {
            break;
        }
        let mut data: u32 = 0;
        for (k, b) in desc[i + 1..i + 1 + size].iter().enumerate() {
            data |= (*b as u32) << (8 * k);
        }
        let typ = (prefix >> 2) & 3;
        let tag = prefix >> 4;
        i += 1 + size;

        match typ {
            // Main
            0 => {
                let kind = match tag {
                    8 => Some(Kind::Input),
                    9 => Some(Kind::Output),
                    11 => Some(Kind::Feature),
                    _ => None,
                };
                if let Some(kind) = kind {
                    if let Some(c) = out.collections.last_mut() {
                        let item = ReportItem { report_size: g.report_size, report_count: g.report_count };
                        let list = match kind {
                            Kind::Input => &mut c.input_reports,
                            Kind::Output => &mut c.output_reports,
                            Kind::Feature => &mut c.feature_reports,
                        };
                        add_item(list, g.report_id, item);
                    }
                    *bits.entry((kind, g.report_id)).or_default() += g.report_size as u64 * g.report_count as u64;
                } else if tag == 10 {
                    // Collection
                    if depth == 0 {
                        let u = usages.first().copied().unwrap_or(0);
                        let page = if u > 0xffff { u >> 16 } else { g.usage_page };
                        out.collections.push(CollectionInfo {
                            usage_page: page as u16,
                            usage: (u & 0xffff) as u16,
                            kind: data as u8,
                            ..Default::default()
                        });
                    }
                    depth += 1;
                } else if tag == 12 {
                    depth = depth.saturating_sub(1);
                }
                usages.clear();
            }
            // Global
            1 => match tag {
                0 => g.usage_page = data,
                7 => g.report_size = data,
                8 => {
                    g.report_id = data as u8;
                    out.numbered = true;
                }
                9 => g.report_count = data,
                10 => stack.push(g),
                11 => {
                    if let Some(s) = stack.pop() {
                        g = s;
                    }
                }
                _ => {}
            },
            // Local
            2 => {
                if tag == 0 {
                    // 4 字节的 Usage 高 16 位是 usage page
                    usages.push(if size == 4 { data } else { data & 0xffff });
                }
            }
            _ => {}
        }
    }

    out.sizes = bits.into_iter().map(|(k, b)| (k, b.div_ceil(8) as usize)).collect();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendor_feature_report() {
        // Usage Page 0xFF05, Usage 1, Collection(Application), Report ID 9, size 8, count 8, Feature, Input, End
        let d = [
            0x06, 0x05, 0xff, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x09, 0x75, 0x08, 0x95, 0x08, 0x09, 0x01, 0xb1, 0x02, 0x09,
            0x01, 0x81, 0x02, 0xc0,
        ];
        let p = parse(&d);
        assert!(p.numbered);
        assert_eq!(p.collections.len(), 1);
        assert_eq!(p.collections[0].usage_page, 0xff05);
        assert_eq!(p.collections[0].usage, 1);
        assert_eq!(p.size(Kind::Feature, 9), Some(8));
        assert_eq!(p.size(Kind::Input, 9), Some(8));
        assert_eq!(p.collections[0].feature_reports[0].report_id, 9);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod live {
    #[test]
    #[ignore]
    fn dump_sysfs() {
        for e in std::fs::read_dir("/sys/class/hidraw").unwrap().flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            let ue = std::fs::read_to_string(format!("/sys/class/hidraw/{n}/device/uevent")).unwrap_or_default();
            if !ue.contains("0000093A") {
                continue;
            }
            let d = std::fs::read(format!("/sys/class/hidraw/{n}/device/report_descriptor")).unwrap();
            let p = super::parse(&d);
            println!("{n}: numbered={} sizes={:?}", p.numbered, p.sizes);
            for c in &p.collections {
                println!("   {:04x}:{:04x} type={} in={:?} feat={:?}", c.usage_page, c.usage, c.kind,
                    c.input_reports.iter().map(|r| r.report_id).collect::<Vec<_>>(),
                    c.feature_reports.iter().map(|r| r.report_id).collect::<Vec<_>>());
            }
        }
    }
}
