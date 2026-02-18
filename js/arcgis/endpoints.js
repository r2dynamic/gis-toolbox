/**
 * ArcGIS REST Endpoint Presets
 * ────────────────────────────
 * Edit this file to add, remove, or reorder the preset layers
 * shown in the ArcGIS REST Import modal.
 *
 * Each entry needs:
 *   name  — Display name shown in the UI
 *   url   — Full ArcGIS REST endpoint URL (FeatureServer or MapServer layer)
 */
const ARCGIS_ENDPOINTS = [
    {
        name: 'UDOT Routes ALRS',
        url: 'https://services.arcgis.com/pA2nEVnB6tquxgOW/ArcGIS/rest/services/UDOT_Routes_ALRS/FeatureServer/0'
    },
    {
        name: 'Linear Measure (LM) Mile Milepost',
        url: 'https://roads.udot.utah.gov/server/rest/services/Public/Mile_Point_Measures_Open_Data/MapServer/0'
    },
    {
        name: 'Linear Measure (LM) Tenth Milepost',
        url: 'https://roads.udot.utah.gov/server/rest/services/Public/Mile_Point_Tenth_Measures_Open_Data/MapServer/0'
    },
    {
        name: 'Physical Location of Reference Post RP',
        url: 'https://services.arcgis.com/pA2nEVnB6tquxgOW/ArcGIS/rest/services/Physical_Location_of_Reference_Post_RP/FeatureServer/3'
    },
    {
        name: 'Federal Aid Mile Point Measures',
        url: 'https://roads.udot.utah.gov/server/rest/services/Public/Federal_Aid_Mile_Point_Measures/MapServer/3'
    },
    {
        name: 'UDOT Region Boundaries',
        url: 'https://central.udot.utah.gov/central/rest/services/UDOT/UDOT_Regions/MapServer/1'
    },
    {
        name: 'UDOT Lanes (2021)',
        url: 'https://services.arcgis.com/pA2nEVnB6tquxgOW/arcgis/rest/services/Lanes/FeatureServer/0'
    },
    {
        name: 'Utah County Boundaries',
        url: 'https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/UtahCountyBoundaries/FeatureServer/0'
    },
    {
        name: 'Utah Municipal Boundaries',
        url: 'https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/UtahMunicipalBoundaries/FeatureServer/0'
    },
    {
        name: 'Utah Roads* (UGRC) *The file will be too big to import without a Fence.',
        url: 'https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/UtahRoads/FeatureServer/0'
    }
];

export default ARCGIS_ENDPOINTS;
