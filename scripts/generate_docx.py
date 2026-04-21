#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate beautifully formatted Word document from storyboard content.
"""

import sys
import os
from docx import Document
from docx.shared import Pt, Cm, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml.ns import qn
from docx.oxml import OxmlElement


def set_chinese_font(run, font_name='微软雅黑', font_size=11):
    """Set Chinese font for a run."""
    run.font.name = font_name
    run.font.size = Pt(font_size)
    r = run._element
    rPr = r.get_or_add_rPr()
    rFonts = rPr.get_or_add_rFonts()
    rFonts.set(qn('w:eastAsia'), font_name)


def add_heading_with_style(doc, text, level, font_name='微软雅黑'):
    """Add a heading with Chinese font."""
    heading = doc.add_heading(level=level)
    run = heading.add_run(text)
    set_chinese_font(run, font_name, 16 if level == 1 else 14 if level == 2 else 12)
    run.bold = True
    return heading


def add_paragraph_with_style(doc, text, font_name='微软雅黑', font_size=11, bold=False, indent=False):
    """Add a paragraph with Chinese font."""
    para = doc.add_paragraph()
    if indent:
        para.paragraph_format.first_line_indent = Cm(0.74)
    para.paragraph_format.line_spacing = 1.5
    para.paragraph_format.space_after = Pt(6)
    run = para.add_run(text)
    set_chinese_font(run, font_name, font_size)
    run.bold = bold
    return para


def add_quote_paragraph(doc, text, font_name='微软雅黑', font_size=10):
    """Add a quote-style paragraph (for narration)."""
    para = doc.add_paragraph()
    para.paragraph_format.left_indent = Cm(1)
    para.paragraph_format.right_indent = Cm(1)
    para.paragraph_format.line_spacing = 1.5
    para.paragraph_format.space_before = Pt(6)
    para.paragraph_format.space_after = Pt(6)

    # Add left border effect using shading
    run = para.add_run(text)
    set_chinese_font(run, font_name, font_size)
    run.italic = True
    return para


def set_table_style(table, font_name='微软雅黑', font_size=9):
    """Apply style to table."""
    # Set table borders using tblPr
    tbl = table._tbl
    tblPr = tbl.tblPr
    if tblPr is None:
        tblPr = OxmlElement('w:tblPr')
        tbl.insert(0, tblPr)

    tblBorders = OxmlElement('w:tblBorders')
    for border_name in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']:
        border = OxmlElement(f'w:{border_name}')
        border.set(qn('w:val'), 'single')
        border.set(qn('w:sz'), '4')
        border.set(qn('w:color'), '666666')
        tblBorders.append(border)
    tblPr.append(tblBorders)

    # Set font for all cells
    for row in table.rows:
        for cell in row.cells:
            for para in cell.paragraphs:
                para.paragraph_format.space_before = Pt(2)
                para.paragraph_format.space_after = Pt(2)
                for run in para.runs:
                    set_chinese_font(run, font_name, font_size)


def shade_header_row(table):
    """Add shading to header row."""
    for cell in table.rows[0].cells:
        shading = OxmlElement('w:shd')
        shading.set(qn('w:fill'), 'E7E6E6')
        cell._tc.get_or_add_tcPr().append(shading)
        for para in cell.paragraphs:
            for run in para.runs:
                run.bold = True


def create_storyboard_docx(data, output_path):
    """
    Create a Word document from storyboard data.

    data structure:
    {
        'title': str,
        'version': str,
        'sections': [
            {
                'type': 'heading1' | 'heading2' | 'paragraph' | 'quote' | 'table',
                'content': str | list,
                'subtitle': str (optional, for section intro)
            }
        ]
    }
    """
    doc = Document()

    # Set document margins
    sections = doc.sections
    for section in sections:
        section.top_margin = Cm(2.54)
        section.bottom_margin = Cm(2.54)
        section.left_margin = Cm(3.17)
        section.right_margin = Cm(3.17)

    # Title
    title = doc.add_heading(level=0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run(data.get('title', '分镜脚本'))
    set_chinese_font(run, '微软雅黑', 22)
    run.bold = True

    # Version info
    if data.get('version'):
        version_para = doc.add_paragraph()
        version_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = version_para.add_run(f"【{data['version']}】")
        set_chinese_font(run, '微软雅黑', 12)

    doc.add_paragraph()  # Spacing

    # Process sections
    for section in data.get('sections', []):
        section_type = section.get('type', 'paragraph')
        content = section.get('content', '')
        subtitle = section.get('subtitle', '')

        if section_type == 'heading1':
            add_heading_with_style(doc, content, level=1)

        elif section_type == 'heading2':
            add_heading_with_style(doc, content, level=2)

        elif section_type == 'heading3':
            add_heading_with_style(doc, content, level=3)

        elif section_type == 'paragraph':
            if subtitle:
                add_paragraph_with_style(doc, subtitle, bold=True)
            add_paragraph_with_style(doc, content, indent=True)

        elif section_type == 'quote':
            add_quote_paragraph(doc, content)

        elif section_type == 'table':
            if subtitle:
                add_paragraph_with_style(doc, subtitle, bold=True)

            table_data = content  # List of lists
            if table_data and len(table_data) > 0:
                rows = len(table_data)
                cols = len(table_data[0])
                table = doc.add_table(rows=rows, cols=cols)
                table.alignment = WD_TABLE_ALIGNMENT.CENTER

                # Fill table data
                for i, row_data in enumerate(table_data):
                    row = table.rows[i]
                    for j, cell_text in enumerate(row_data):
                        cell = row.cells[j]
                        cell.text = str(cell_text)

                # Style table
                set_table_style(table)
                shade_header_row(table)

                doc.add_paragraph()  # Spacing after table

    # Save document
    doc.save(output_path)
    return output_path


def parse_markdown_to_data(md_content, title=None, version=None):
    """
    Parse markdown content to data structure for Word generation.
    Simple parser for storyboard markdown format.
    """
    lines = md_content.split('\n')
    sections = []
    current_table = []
    in_table = False

    for line in lines:
        line = line.rstrip()

        # Skip empty lines
        if not line:
            if in_table and current_table:
                # End of table
                sections.append({
                    'type': 'table',
                    'content': current_table
                })
                current_table = []
                in_table = False
            continue

        # Headings
        if line.startswith('# '):
            if in_table and current_table:
                sections.append({'type': 'table', 'content': current_table})
                current_table = []
                in_table = False
            sections.append({'type': 'heading1', 'content': line[2:]})
        elif line.startswith('## '):
            if in_table and current_table:
                sections.append({'type': 'table', 'content': current_table})
                current_table = []
                in_table = False
            sections.append({'type': 'heading2', 'content': line[3:]})
        elif line.startswith('### '):
            if in_table and current_table:
                sections.append({'type': 'table', 'content': current_table})
                current_table = []
                in_table = False
            sections.append({'type': 'heading3', 'content': line[4:]})

        # Quote
        elif line.startswith('> '):
            if in_table and current_table:
                sections.append({'type': 'table', 'content': current_table})
                current_table = []
                in_table = False
            sections.append({'type': 'quote', 'content': line[2:]})

        # Table
        elif line.startswith('|'):
            in_table = True
            # Parse table row
            cells = [cell.strip() for cell in line.split('|')[1:-1]]
            # Skip separator rows (like |---|---|)
            if cells and not all(set(c) <= {'-', ':', ' '} for c in cells):
                current_table.append(cells)

        # Regular paragraph
        else:
            if in_table and current_table:
                sections.append({'type': 'table', 'content': current_table})
                current_table = []
                in_table = False

            # Skip list markers for clean text
            if line.startswith('- '):
                line = '• ' + line[2:]
            elif line.startswith('* '):
                line = '• ' + line[2:]

            sections.append({'type': 'paragraph', 'content': line})

    # Handle remaining table
    if current_table:
        sections.append({'type': 'table', 'content': current_table})

    return {
        'title': title or '分镜脚本',
        'version': version,
        'sections': sections
    }


def main():
    """Main entry point."""
    if len(sys.argv) < 3:
        print("Usage: python generate_docx.py <input.md> <output.docx> [--title TITLE] [--version VERSION]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    # Parse optional arguments
    title = None
    version = None
    i = 3
    while i < len(sys.argv):
        if sys.argv[i] == '--title' and i + 1 < len(sys.argv):
            title = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == '--version' and i + 1 < len(sys.argv):
            version = sys.argv[i + 1]
            i += 2
        else:
            i += 1

    # Read markdown content
    with open(input_path, 'r', encoding='utf-8') as f:
        md_content = f.read()

    # Parse and generate
    data = parse_markdown_to_data(md_content, title, version)
    create_storyboard_docx(data, output_path)

    print(f"Word document generated: {output_path}")


if __name__ == '__main__':
    main()
