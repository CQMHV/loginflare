ALTER TABLE "siteBranding" ADD COLUMN "colorScheme" TEXT NOT NULL DEFAULT 'tonal-spot'
CHECK ("colorScheme" IN ('tonal-spot', 'fidelity', 'monochrome', 'neutral', 'vibrant', 'expressive', 'content', 'rainbow', 'fruit-salad'));
