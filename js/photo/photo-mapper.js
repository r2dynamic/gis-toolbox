/**
 * Photo Mapper — EXIF extraction, mapping, export
 * Uses exifr for EXIF parsing (loaded via CDN)
 */
import logger from '../core/logger.js';
import { createSpatialDataset } from '../core/data-model.js';
import { TaskRunner } from '../core/task-runner.js';
import bus from '../core/event-bus.js';

export class PhotoMapper {
    constructor() {
        this.photos = [];
        this.dataset = null;
    }

    async processPhotos(files, task) {
        const t = task || new TaskRunner('Photo Processing', 'PhotoMapper');

        return t.run ? await t.run(async (runner) => {
            return this._process(files, runner);
        }) : await this._process(files, t);
    }

    async _process(files, task) {
        this.photos = [];
        const total = files.length;
        logger.info('PhotoMapper', 'Processing photos', { count: total });

        for (let i = 0; i < total; i++) {
            task.throwIfCancelled?.();
            task.updateProgress(Math.round((i / total) * 90), `Processing photo ${i + 1}/${total}`);

            const file = files[i];
            const photoInfo = {
                filename: file.name,
                size: file.size,
                type: file.type,
                blob: file,
                thumbnail: null,
                gps: null,
                timestamp: null,
                altitude: null,
                heading: null,
                hasGPS: false,
                error: null
            };

            try {
                // Check for HEIC
                if (file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif')) {
                    photoInfo.error = 'HEIC format may not be supported in all browsers. Convert to JPG for best results.';
                    logger.warn('PhotoMapper', 'HEIC file detected', { file: file.name });
                }

                // Extract EXIF
                const exifData = await this.extractEXIF(file);

                if (exifData) {
                    if (exifData.latitude != null && exifData.longitude != null) {
                        photoInfo.gps = { lat: exifData.latitude, lon: exifData.longitude };
                        photoInfo.hasGPS = true;
                    }
                    if (exifData.DateTimeOriginal || exifData.CreateDate) {
                        photoInfo.timestamp = exifData.DateTimeOriginal || exifData.CreateDate;
                        if (photoInfo.timestamp instanceof Date) {
                            photoInfo.timestamp = photoInfo.timestamp.toISOString();
                        }
                    }
                    if (exifData.GPSAltitude != null) {
                        photoInfo.altitude = exifData.GPSAltitude;
                    }
                    if (exifData.GPSImgDirection != null) {
                        photoInfo.heading = exifData.GPSImgDirection;
                    }
                }

                // Create thumbnail
                try {
                    photoInfo.thumbnail = await this.createThumbnail(file, 320);
                    photoInfo.thumbnailUrl = URL.createObjectURL(photoInfo.thumbnail);
                } catch (e) {
                    logger.warn('PhotoMapper', 'Thumbnail creation failed', { file: file.name, error: e.message });
                    // Create object URL directly for preview
                    photoInfo.thumbnailUrl = URL.createObjectURL(file);
                }

            } catch (e) {
                photoInfo.error = e.message;
                logger.error('PhotoMapper', 'EXIF extraction failed', { file: file.name, error: e.message });
                // Still allow the photo reference
                try {
                    photoInfo.thumbnailUrl = URL.createObjectURL(file);
                } catch (_) { }
            }

            this.photos.push(photoInfo);
        }

        // Build dataset from GPS photos
        this.dataset = this.buildDataset();

        const gpsCount = this.photos.filter(p => p.hasGPS).length;
        const noGpsCount = this.photos.length - gpsCount;
        logger.info('PhotoMapper', 'Processing complete', { total, withGPS: gpsCount, withoutGPS: noGpsCount });

        task.updateProgress(100, 'Done');
        bus.emit('photos:processed', {
            total: this.photos.length,
            withGPS: gpsCount,
            withoutGPS: noGpsCount,
            dataset: this.dataset
        });

        return {
            photos: this.photos,
            dataset: this.dataset,
            withGPS: gpsCount,
            withoutGPS: noGpsCount
        };
    }

    async extractEXIF(file) {
        // Use exifr library if available
        if (typeof exifr !== 'undefined') {
            try {
                const data = await exifr.parse(file, {
                    gps: true,
                    tiff: true,
                    exif: true,
                    pick: ['GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'GPSImgDirection',
                        'DateTimeOriginal', 'CreateDate', 'Make', 'Model']
                });
                return data;
            } catch (e) {
                logger.warn('PhotoMapper', 'exifr parse failed', { file: file.name, error: e.message });
                return null;
            }
        }

        // Fallback: basic EXIF extraction not available
        logger.warn('PhotoMapper', 'exifr not loaded, no EXIF extraction possible');
        return null;
    }

    async createThumbnail(file, maxSize = 320) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);

            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    let { width, height } = img;
                    if (width > height) {
                        if (width > maxSize) { height = height * maxSize / width; width = maxSize; }
                    } else {
                        if (height > maxSize) { width = width * maxSize / height; height = maxSize; }
                    }
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    canvas.toBlob(blob => {
                        URL.revokeObjectURL(url);
                        if (blob) resolve(blob);
                        else reject(new Error('Thumbnail blob creation failed'));
                    }, 'image/jpeg', 0.7);
                } catch (e) {
                    URL.revokeObjectURL(url);
                    reject(e);
                }
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Image load failed — format may not be supported'));
            };

            img.src = url;
        });
    }

    buildDataset() {
        const gpsPhotos = this.photos.filter(p => p.hasGPS);
        if (gpsPhotos.length === 0) return null;

        const features = gpsPhotos.map(p => ({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [p.gps.lon, p.gps.lat]
            },
            properties: {
                filename: p.filename,
                timestamp: p.timestamp || '',
                latitude: p.gps.lat,
                longitude: p.gps.lon,
                altitude: p.altitude || '',
                heading: p.heading || '',
                fileSize: p.size
            }
        }));

        const geojson = { type: 'FeatureCollection', features };
        return createSpatialDataset('Photo_Points', geojson, { format: 'photos' });
    }

    getPhotos() { return this.photos; }
    getDataset() { return this.dataset; }

    getPhotosForExport() {
        return this.photos.filter(p => p.hasGPS).map(p => ({
            filename: p.filename,
            blob: p.blob,
            thumbnail: p.thumbnail
        }));
    }

    cleanup() {
        for (const p of this.photos) {
            if (p.thumbnailUrl) {
                try { URL.revokeObjectURL(p.thumbnailUrl); } catch (_) { }
            }
        }
        this.photos = [];
        this.dataset = null;
    }
}

export const photoMapper = new PhotoMapper();
export default photoMapper;
