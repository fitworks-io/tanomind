-- Long = essay-length context (>280 chars) or multi-paragraph body, not every title + short blurb.
UPDATE topics
SET content_format = 'long'
WHERE trim(body) != ''
  AND (length(trim(body)) > 280 OR instr(trim(body), char(10) || char(10)) > 0);

UPDATE topics
SET content_format = 'short'
WHERE trim(body) = ''
   OR (length(trim(body)) <= 280 AND instr(trim(body), char(10) || char(10)) = 0);
