insert into monitors (name, url, interval_s, timeout_s, enabled, disabled_at) values
  ('google',       'https://www.google.com',              10, 5, true,  null),
  ('denisantonov', 'https://denisantonov.com',            15, 5, true,  null),
  ('badhost',      'https://this-does-not-exist.invalid', 10, 5, true,  null),
  ('notfound',     'https://www.google.com/nothing-here', 20, 5, true,  null),
  ('slowpoke',     'https://httpbin.org/delay/10',        30, 2, true,  null),
  ('retired',      'https://example.com',                 60, 5, false, now());
