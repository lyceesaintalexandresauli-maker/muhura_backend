-- Create gallery table for managing school photos and videos

CREATE TABLE gallery (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255),
  media_path VARCHAR(500) NOT NULL,
  media_type VARCHAR(20) NOT NULL CHECK (media_type IN ('image', 'video')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_gallery_media_type ON gallery(media_type);
CREATE INDEX idx_gallery_is_active ON gallery(is_active);
