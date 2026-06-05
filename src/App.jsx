import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, X, AlertCircle, LogIn, Info, ChevronsUpDown, CheckCircle, Upload } from 'lucide-react';

const CLIENT_ID = '52410'; 
const API_KEY = 'd7873948e4c74594845880f5aafa9b81'; 
const REDIRECT_URI = window.location.origin + window.location.pathname;

const BUNGIE_ROOT = 'https://www.bungie.net';
const getBungieUrl = (path) => (path ? `${BUNGIE_ROOT}${path}` : '');

const CLASS_MAP = { 0: 'Titan', 1: 'Hunter', 2: 'Warlock' };
const SLOT_MAP = {
  45: 'Helmet',
  46: 'Arms',
  47: 'Chest',
  48: 'Legs',
  49: 'Class Item'
};

const STAT_MAP = {
  2996146975: 'Weapons',
  392767087: 'Health',
  1943323491: 'Class',
  1735777505: 'Grenade',
  4244567218: 'Melee',
  144602215: 'Super'
};

const STAT_NAME_TO_HASH = {
  'Weapons': 2996146975,
  'Health': 392767087,
  'Class': 1943323491,
  'Grenade': 1735777505,
  'Melee': 4244567218,
  'Super': 144602215
};

const STAT_ORDER = [
  392767087,  // Health
  4244567218, // Melee
  1735777505, // Grenade
  144602215,  // Super
  1943323491, // Class
  2996146975  // Weapons
];

const PROBE_MODS = [
  { stat: 'Grenade', hash: 309000506 },
  { stat: 'Melee', hash: 311164277 },
  { stat: 'Class', hash: 323635379 },
  { stat: 'Health', hash: 388618952 },
  { stat: 'Super', hash: 673231129 },
  { stat: 'Weapons', hash: 691392383 }
];

export default function App() {
  const [appState, setAppState] = useState('idle'); 
  const [errorMsg, setErrorMsg] = useState(null);
  
  const [authInfo, setAuthInfo] = useState(null);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [toastInfo, setToastInfo] = useState(null);
  
  const [manifest, setManifest] = useState(null);
  const [characters, setCharacters] = useState([]);
  const [armorItems, setArmorItems] = useState([]);
  
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedClass, setSelectedClass] = useState(0);

  const [modSelector, setModSelector] = useState(null);
  const [tooltipData, setTooltipData] = useState(null);
  
  const [cacheVersion, setCacheVersion] = useState(0); 
  const [workerStatus, setWorkerStatus] = useState({ active: false, remaining: 0 });

  const actionLoadingRef = useRef(false);
  const authInfoRef = useRef(null);
  const probeQueueRef = useRef([]);
  const workerRunningRef = useRef(false);
  const fileInputRef = useRef(null);

  useEffect(() => { actionLoadingRef.current = isActionLoading; }, [isActionLoading]);
  useEffect(() => { authInfoRef.current = authInfo; }, [authInfo]);

  useEffect(() => {
    window.__D2_MANIFEST = manifest;
    window.__D2_SELECTED_ITEM = selectedItem;
    window.__D2_PROFILE = window.__D2_PROFILE || null;
  }, [manifest, selectedItem]);

  useEffect(() => {
    const handleScroll = () => setTooltipData(null);
    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, []);

  useEffect(() => {
    if (toastInfo) {
      const timer = setTimeout(() => setToastInfo(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toastInfo]);

  const groupedArmor = useMemo(() => {
    const groups = {
      0: { 45: [], 46: [], 47: [], 48: [], 49: [] },
      1: { 45: [], 46: [], 47: [], 48: [], 49: [] },
      2: { 45: [], 46: [], 47: [], 48: [], 49: [] },
    };

    armorItems.forEach(item => {
      const cType = item.definition.classType;
      if (groups[cType]) {
        const cats = item.definition.itemCategoryHashes || [];
        const slot = [45, 46, 47, 48, 49].find(h => cats.includes(h));
        if (slot) {
          groups[cType][slot].push(item);
        }
      }
    });
    return groups;
  }, [armorItems]);

  useEffect(() => {
    const initialize = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');

      if (code) {
        window.history.replaceState({}, document.title, window.location.pathname);
        await processAuthFlow(code);
      } else {
        setAppState('login');
      }
    };
    initialize();
  }, []);

  // Background Scanner & Cache Cleanup
  useEffect(() => {
    if (appState !== 'ready' || !manifest) return;
    
    const needsProbe = [];
    const cache = JSON.parse(localStorage.getItem('d2_tuning_cache') || '{}');
    let cacheCleaned = false;
    const validInstanceIds = new Set();

    const checkItemForProbe = (item) => {
        if (!item || item.definition.itemType !== 2) return;
        
        validInstanceIds.add(item.itemInstanceId); // Track active items for cache sweep

        const isArmor3 = item.sockets?.some(s => {
            if (!s.plugHash) return false;
            const def = manifest.items[s.plugHash];
            if (!def) return false;
            const name = def.displayProperties?.name || "";
            const typeName = def.itemTypeDisplayName || "";
            
            // An archetype has no type name, is not empty, and is NOT the Upgrade or Ornament socket
            return typeName === "" && 
                   !name.includes("Empty") && 
                   name !== "Upgrade Armor" && 
                   !name.startsWith("Upgrade to") &&
                   name !== "Default Ornament";
        }); 
        
        // Only queue it if it's 3.0 and not currently saved in our local cache and tier 5
        if (isArmor3 && !cache[item.itemInstanceId] && (item.instanceData?.gearTier == 5)) {
            needsProbe.push(item);
        }
    };

    armorItems.forEach(checkItemForProbe);
    characters.forEach(char => char.equippedArmor.forEach(checkItemForProbe));

    // Housekeeping: Delete any cached stats for armor that has been dismantled or transferred
    Object.keys(cache).forEach(cachedId => {
       if (!validInstanceIds.has(cachedId)) {
           delete cache[cachedId];
           cacheCleaned = true;
       }
    });

    if (cacheCleaned) {
       localStorage.setItem('d2_tuning_cache', JSON.stringify(cache));
    }

    // Replace the queue entirely so CSV uploads force an instant sync
    probeQueueRef.current = needsProbe;
    setWorkerStatus(prev => ({ ...prev, remaining: needsProbe.length }));

    if (needsProbe.length > 0 && !workerRunningRef.current) {
        startBackgroundWorker();
    }
  }, [armorItems, characters, appState, manifest, cacheVersion]);

  const startBackgroundWorker = async () => {
    workerRunningRef.current = true;
    setWorkerStatus(prev => ({ ...prev, active: true }));

    while (probeQueueRef.current.length > 0) {
        // Yield if the user is making a manual change
        while (actionLoadingRef.current) await new Promise(r => setTimeout(r, 1000));

        const item = probeQueueRef.current[0];
        if (!item) break;
        
        // Double check it wasn't caught by a CSV upload mid-run
        const currentCache = JSON.parse(localStorage.getItem('d2_tuning_cache') || '{}');
        if (currentCache[item.itemInstanceId]) {
            probeQueueRef.current = probeQueueRef.current.filter(i => i.itemInstanceId !== item.itemInstanceId);
            setWorkerStatus(prev => ({ ...prev, remaining: probeQueueRef.current.length }));
            continue;
        }

        // Find the tuning socket securely by checking the plug pool for tradeoff mods
        let tuningSocketIndex = -1;
        const armorFullDef = manifest.items[item.itemHash];
        
        item.sockets?.forEach((s, i) => {
             const socketDef = armorFullDef?.sockets?.socketEntries?.[i];
             const plugSetHash = socketDef?.reusablePlugSetHash || socketDef?.randomizedPlugSetHash;
             if (plugSetHash) {
                 const pData = manifest.plugSets[plugSetHash];
                 // If the pool contains tradeoff mods, this is the tuning socket!
                 const hasTuningMods = pData?.reusablePlugItems?.some(p => {
                     const pName = manifest.items[p.plugItemHash]?.displayProperties?.name || "";
                     return pName.includes("/") && pName.startsWith("+");
                 });
                 if (hasTuningMods) tuningSocketIndex = i;
             }
        });

        if (tuningSocketIndex === -1) {
            probeQueueRef.current = probeQueueRef.current.filter(i => i.itemInstanceId !== item.itemInstanceId);
            continue;
        }

        const charId = getTargetCharId(item);
        const originalPlugHash = item.sockets[tuningSocketIndex].plugHash;
        let foundStat = null;

        // Try the 6 universal probe mods
        for (const probe of PROBE_MODS) {
            // Respect rate limits and user actions
            while (actionLoadingRef.current) await new Promise(r => setTimeout(r, 1000));
            await new Promise(r => setTimeout(r, 1500));
            if (actionLoadingRef.current) continue;

            try {
                const res = await fetch(`${BUNGIE_ROOT}/Platform/Destiny2/Actions/Items/InsertSocketPlugFree/`, {
                    method: 'POST',
                    headers: { 'X-API-Key': API_KEY, 'Authorization': `Bearer ${authInfoRef.current.token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        plug: { socketIndex: tuningSocketIndex, socketArrayType: 0, plugItemHash: probe.hash },
                        itemId: item.itemInstanceId, characterId: charId, membershipType: authInfoRef.current.membershipType
                    })
                });
                const data = await res.json();
                
                if (data.ErrorCode === 1) {
                    foundStat = probe.stat;
                    break;
                }
            } catch (e) {
                // Silently absorb expected HTTP errors (1618 Unexpected Error or 400 Bad Request)
            }
        }

        if (foundStat) {
            // Save success to cache!
            const cache = JSON.parse(localStorage.getItem('d2_tuning_cache') || '{}');
            cache[item.itemInstanceId] = foundStat;
            localStorage.setItem('d2_tuning_cache', JSON.stringify(cache));
            
            setCacheVersion(v => v + 1); 

            // Clean up: Re-insert the original empty socket so the vault stays clean
            while (actionLoadingRef.current) await new Promise(r => setTimeout(r, 1000));
            await new Promise(r => setTimeout(r, 1500));
            
            try {
                await fetch(`${BUNGIE_ROOT}/Platform/Destiny2/Actions/Items/InsertSocketPlugFree/`, {
                    method: 'POST',
                    headers: { 'X-API-Key': API_KEY, 'Authorization': `Bearer ${authInfoRef.current.token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        plug: { socketIndex: tuningSocketIndex, socketArrayType: 0, plugItemHash: originalPlugHash },
                        itemId: item.itemInstanceId, characterId: charId, membershipType: authInfoRef.current.membershipType
                    })
                });
            } catch(e) {}
        }

        probeQueueRef.current = probeQueueRef.current.filter(i => i.itemInstanceId !== item.itemInstanceId);
        setWorkerStatus({ active: true, remaining: probeQueueRef.current.length });
    }

    workerRunningRef.current = false;
    setWorkerStatus({ active: false, remaining: 0 });
  };

  const handleCsvUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const lines = text.split('\n');
        if (lines.length < 2) throw new Error("File is empty or invalid.");

        const headers = lines[0].split(',');
        const idIndex = headers.indexOf('Id');
        const tuningIndex = headers.indexOf('Tuning Stat');

        if (idIndex === -1 || tuningIndex === -1) {
          throw new Error("Could not find 'Id' or 'Tuning Stat' columns in the CSV.");
        }

        let updatedCount = 0;
        const currentCache = JSON.parse(localStorage.getItem('d2_tuning_cache') || '{}');

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line.trim()) continue;

          // Parse CSV row ignoring commas inside quotes
          const columns = [];
          let inQuotes = false;
          let currentStr = '';
          for (let char of line) {
            if (char === '"') {
              inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
              columns.push(currentStr);
              currentStr = '';
            } else {
              currentStr += char;
            }
          }
          columns.push(currentStr);

          let id = columns[idIndex];
          let tuningStat = columns[tuningIndex];

          if (id && tuningStat) {
            id = id.replace(/"/g, '').trim();
            tuningStat = tuningStat.trim();
            
            if (tuningStat) {
              // Ensure proper casing (e.g. 'super' -> 'Super')
              tuningStat = tuningStat.charAt(0).toUpperCase() + tuningStat.slice(1).toLowerCase();
              
              if (STAT_NAME_TO_HASH[tuningStat]) {
                currentCache[id] = tuningStat;
                updatedCount++;
              }
            }
          }
        }

        localStorage.setItem('d2_tuning_cache', JSON.stringify(currentCache));
        setCacheVersion(v => v + 1); // Trigger UI re-render
        setToastInfo({ message: `Successfully imported ${updatedCount} tuning stats from DIM!`, type: 'success' });
        
      } catch (err) {
        setToastInfo({ message: err.message, type: 'error' });
      }
      
      event.target.value = null; // Reset input
    };
    reader.readAsText(file);
  };

  const processAuthFlow = async (code) => {
    try {
      setAppState('loading_auth');
      
      const tokenData = await fetchToken(code);
      if (!tokenData || !tokenData.access_token) throw new Error("Failed to authenticate with Bungie.");
      
      setAppState('loading_manifest');
      const manifestData = await fetchManifest();
      setManifest(manifestData);

      setAppState('loading_profile');
      const memberships = await fetchMemberships(tokenData.access_token);
      if (!memberships || memberships.length === 0) throw new Error("No Destiny 2 memberships found for this account.");
      
      const primaryMembership = memberships.find(m => m.membershipId === memberships.primaryMembershipId) || memberships[0];
      
      setAuthInfo({
         token: tokenData.access_token,
         membershipType: primaryMembership.membershipType,
         membershipId: primaryMembership.membershipId
      });

      const profileData = await fetchProfile(primaryMembership.membershipType, primaryMembership.membershipId, tokenData.access_token);
      window.__D2_PROFILE = profileData;
      processInventory(profileData, manifestData);

      setAppState('ready');
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || "An unexpected error occurred.");
      setAppState('error');
    }
  };

  const loginToBungie = () => {
    const authUrl = `https://www.bungie.net/en/OAuth/Authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    window.location.href = authUrl;
  };

  const refreshProfileData = async () => {
    if (!authInfo || !manifest) return;
    setIsActionLoading(true);
    try {
      const profileData = await fetchProfile(authInfo.membershipType, authInfo.membershipId, authInfo.token);
      window.__D2_PROFILE = profileData;
      processInventory(profileData, manifest);
    } catch (e) {
      console.error(e);
      setToastInfo({ message: "Failed to refresh profile after equipping.", type: 'error' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const fetchToken = async (code) => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: code
    });

    const response = await fetch(`${BUNGIE_ROOT}/Platform/App/OAuth/Token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error_description || "Authentication failed.");
    return data;
  };

  const fetchManifest = async () => {
    const res = await fetch(`${BUNGIE_ROOT}/Platform/Destiny2/Manifest/`, { headers: { 'X-API-Key': API_KEY } });
    const manifestInfo = await res.json();
    const paths = manifestInfo.Response.jsonWorldComponentContentPaths.en;
    
    const [itemsRes, setsRes, perksRes, plugSetsRes] = await Promise.all([
      fetch(getBungieUrl(paths.DestinyInventoryItemDefinition)),
      fetch(getBungieUrl(paths.DestinyEquipableItemSetDefinition)),
      fetch(getBungieUrl(paths.DestinySandboxPerkDefinition)),
      fetch(getBungieUrl(paths.DestinyPlugSetDefinition))
    ]);

    const items = await itemsRes.json();
    const sets = await setsRes.json();
    const perks = await perksRes.json();
    const plugSets = await plugSetsRes.json();

    return { items, sets, perks, plugSets };
  };

  const fetchMemberships = async (token) => {
    const res = await fetch(`${BUNGIE_ROOT}/Platform/User/GetMembershipsForCurrentUser/`, {
      headers: { 'X-API-Key': API_KEY, 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    return data.Response.destinyMemberships;
  };

  const fetchProfile = async (membershipType, membershipId, token) => {
    const res = await fetch(`${BUNGIE_ROOT}/Platform/Destiny2/${membershipType}/Profile/${membershipId}/?components=102,200,201,205,300,304,305,800,801`, {
      headers: { 'X-API-Key': API_KEY, 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    return data.Response;
  };

  const equipItemAction = async (itemInstanceId, characterId) => {
    setIsActionLoading(true);
    try {
      const res = await fetch(`${BUNGIE_ROOT}/Platform/Destiny2/Actions/Items/EquipItem/`, {
         method: 'POST',
         headers: {
            'X-API-Key': API_KEY,
            'Authorization': `Bearer ${authInfo.token}`,
            'Content-Type': 'application/json'
         },
         body: JSON.stringify({
            itemId: itemInstanceId,
            characterId: characterId,
            membershipType: authInfo.membershipType
         })
      });
      const data = await res.json();
      if (data.ErrorCode !== 1) throw new Error(data.Message);
      
      setToastInfo({ message: "Successfully equipped!", type: 'success' });
      setModSelector(null);
      setTimeout(() => refreshProfileData(), 3000);
    } catch (e) {
      setToastInfo({ message: e.message, type: 'error' });
      setIsActionLoading(false);
    }
  };

  const equipModAction = async (itemInstanceId, socketIndex, plugItemHash, characterId) => {
    setIsActionLoading(true);
    try {
      const res = await fetch(`${BUNGIE_ROOT}/Platform/Destiny2/Actions/Items/InsertSocketPlugFree/`, {
         method: 'POST',
         headers: {
            'X-API-Key': API_KEY,
            'Authorization': `Bearer ${authInfo.token}`,
            'Content-Type': 'application/json'
         },
         body: JSON.stringify({
            plug: {
               socketIndex: socketIndex,
               socketArrayType: 0,
               plugItemHash: plugItemHash
            },
            itemId: itemInstanceId,
            characterId: characterId,
            membershipType: authInfo.membershipType
         })
      });
      const data = await res.json();
      if (data.ErrorCode !== 1) throw new Error(data.Message);
      
      // If we just successfully equipped a tradeoff mod, cache the stat!
      const plugDef = manifest.items[plugItemHash];
      const plugName = plugDef?.displayProperties?.name || "";
      if (plugName.includes("/") && plugName.startsWith("+")) {
         const match = plugName.match(/^\+([A-Za-z]+)\s*\//);
         if (match) {
             const cache = JSON.parse(localStorage.getItem('d2_tuning_cache') || '{}');
             cache[itemInstanceId] = match[1];
             localStorage.setItem('d2_tuning_cache', JSON.stringify(cache));
             setCacheVersion(v => v + 1);
         }
      }

      setModSelector(null);
      setToastInfo({ message: "Mod successfully applied!", type: 'success' });
      setTimeout(() => refreshProfileData(), 3000);
    } catch (e) {
      setToastInfo({ message: e.message, type: 'error' });
      setIsActionLoading(false);
    }
  };

  const getTargetCharId = (item) => {
     if (item.characterId) return item.characterId;
     const matchingChar = characters.find(c => c.classType === item.definition.classType);
     return matchingChar ? matchingChar.characterId : characters[0]?.characterId;
  };

  const processInventory = (profile, manifestDb) => {
    let allItems = [];
    const equippedInstanceIds = new Set();

    if (profile.profileInventory?.data?.items) {
      allItems = [...allItems, ...profile.profileInventory.data.items.map(i => ({...i, location: 'vault'}))];
    }
    
    if (profile.characterInventories?.data) {
      Object.entries(profile.characterInventories.data).forEach(([charId, char]) => {
        allItems = [...allItems, ...char.items.map(i => ({...i, location: 'inventory', characterId: charId}))];
      });
    }

    let charsArray = [];
    if (profile.characters?.data && profile.characterEquipment?.data) {
       charsArray = Object.values(profile.characters.data).map(char => {
          const equippedRaw = profile.characterEquipment.data[char.characterId]?.items || [];
          
          const equippedArmor = equippedRaw.reduce((acc, item) => {
             const def = manifestDb.items[item.itemHash];
             if (def && def.itemType === 2) {
                const instanceId = item.itemInstanceId;
                equippedInstanceIds.add(instanceId);
                
                const socketsRaw = profile.itemComponents?.sockets?.data?.[instanceId]?.sockets || [];
                const reusablePlugsRaw = profile.itemComponents?.reusablePlugs?.data?.[instanceId]?.plugs || {};
                const mappedSockets = socketsRaw.map((s, idx) => ({ ...s, reusablePlugs: reusablePlugsRaw[idx] || [] }));

                acc.push({
                   ...item,
                   definition: def,
                   stats: profile.itemComponents?.stats?.data?.[instanceId]?.stats || {},
                   sockets: mappedSockets,
                   instanceData: profile.itemComponents?.instances?.data?.[instanceId] || {},
                   characterId: char.characterId
                });
             }
             return acc;
          }, []);

          equippedArmor.sort((a, b) => {
             const getHash = i => Math.min(...i.definition.itemCategoryHashes.filter(h => h >= 45 && h <= 49));
             return getHash(a) - getHash(b);
          });

          // Subclass Extraction
          const subclassRaw = equippedRaw.find(item => manifestDb.items[item.itemHash]?.itemType === 16);
          let subclass = null;
          if (subclassRaw) {
             const instanceId = subclassRaw.itemInstanceId;
             const socketsRaw = profile.itemComponents?.sockets?.data?.[instanceId]?.sockets || [];
             const reusablePlugsRaw = profile.itemComponents?.reusablePlugs?.data?.[instanceId]?.plugs || {};
             const mappedSockets = socketsRaw.map((s, idx) => ({ ...s, reusablePlugs: reusablePlugsRaw[idx] || [] }));
             subclass = {
                ...subclassRaw,
                definition: manifestDb.items[subclassRaw.itemHash],
                sockets: mappedSockets,
                instanceData: profile.itemComponents?.instances?.data?.[instanceId] || {},
                characterId: char.characterId
             };
          }

          // Fetch Unequipped Subclasses for the Switcher
          const unequippedSubclasses = (profile.characterInventories?.data?.[char.characterId]?.items || [])
             .filter(i => manifestDb.items[i.itemHash]?.itemType === 16)
             .map(subRaw => ({
                  ...subRaw,
                  definition: manifestDb.items[subRaw.itemHash],
                  characterId: char.characterId
             }));

          return { ...char, equippedArmor, subclass, unequippedSubclasses };
       });
       
       charsArray.sort((a, b) => new Date(b.dateLastPlayed) - new Date(a.dateLastPlayed));
       setCharacters(charsArray);
    }

    const armorList = allItems.reduce((acc, item) => {
      if (equippedInstanceIds.has(item.itemInstanceId)) return acc;

      const def = manifestDb.items[item.itemHash];
      if (def && def.itemType === 2) {
        const instanceId = item.itemInstanceId;
        const stats = instanceId && profile.itemComponents?.stats?.data?.[instanceId]?.stats;
        const instanceData = instanceId && profile.itemComponents?.instances?.data?.[instanceId];

        const socketsRaw = instanceId && profile.itemComponents?.sockets?.data?.[instanceId]?.sockets || [];
        const reusablePlugsRaw = instanceId && profile.itemComponents?.reusablePlugs?.data?.[instanceId]?.plugs || {};
        const mappedSockets = socketsRaw.map((s, idx) => ({ ...s, reusablePlugs: reusablePlugsRaw[idx] || [] }));

        acc.push({
          ...item,
          definition: def,
          stats: stats || {},
          sockets: mappedSockets,
          instanceData: instanceData || {}
        });
      }
      return acc;
    }, []);

    armorList.sort((a, b) => {
      const tierDiff = (b.definition.inventory?.tierType || 0) - (a.definition.inventory?.tierType || 0);
      if (tierDiff !== 0) return tierDiff;
      return a.definition.displayProperties.name.localeCompare(b.definition.displayProperties.name);
    });

    setArmorItems(armorList);
    
    // Ensure open modals retain state
    setSelectedItem(prev => {
        if (!prev) return null;
        const updatedEquipped = charsArray.flatMap(c => c.equippedArmor).find(a => a.itemInstanceId === prev.itemInstanceId);
        const updatedInventory = armorList.find(a => a.itemInstanceId === prev.itemInstanceId);
        return updatedEquipped || updatedInventory || prev;
    });
  };

  const getTierColor = (tierType) => {
    switch (tierType) {
      case 6: return 'border-yellow-500 shadow-[0_0_10px_rgba(234,179,8,0.5)]';
      case 5: return 'border-purple-500 shadow-[0_0_10px_rgba(168,85,247,0.5)]';
      case 4: return 'border-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]';
      case 3: return 'border-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]';
      default: return 'border-gray-500 shadow-sm';
    }
  };

  const getModDescription = (modDef) => {
    let descText = modDef.displayProperties?.description || "";
    if (!descText && modDef.perks && modDef.perks.length > 0) {
      const perkDescs = modDef.perks
        .map(p => manifest.perks[p.perkHash]?.displayProperties?.description)
        .filter(Boolean);
      descText = [...new Set(perkDescs)].join('\n\n');
    }
    return descText;
  };

  const parseSockets = (targetItem) => {
    const sockets = targetItem?.sockets;
    const categories = {
      masterwork: [], archetype: [], statsAndTuning: [], slotMods: [], miscMods: [], intrinsic: [], cosmetics: [],
      statMods: { 2996146975: 0, 392767087: 0, 1943323491: 0, 1735777505: 0, 4244567218: 0, 144602215: 0 },
      tuningMods: { 2996146975: 0, 392767087: 0, 1943323491: 0, 1735777505: 0, 4244567218: 0, 144602215: 0 },
      hasBalancedTuning: false, tuningStatName: null, zeroBaseHashes: []
    };

    if (!sockets) return categories;

    // Scan for equipped Tuning Mods to deduce the tuning stat automatically
    sockets.forEach((socket, idx) => {
      if (socket.reusablePlugs && socket.reusablePlugs.length > 0) {
        socket.reusablePlugs.forEach(rp => {
          const rpDef = manifest.items[rp.plugItemHash];
          const rpName = rpDef?.displayProperties?.name || "";
          if (rpName.includes("/") && rpName.startsWith("+")) {
             const match = rpName.match(/^\+([A-Za-z]+)\s*\//);
             if (match) categories.tuningStatName = match[1];
          }
        });
      }

      if (!socket.plugHash) return;
      const def = manifest.items[socket.plugHash];
      if (!def || !def.displayProperties || !def.displayProperties.name) return;

      const name = def.displayProperties.name;
      const typeName = def.itemTypeDisplayName || "";
      const subType = def.itemSubType;
      const modObj = { ...def, socketIndex: idx };

      // Categorization
      if (subType === 20 || subType === 21 || typeName === "Shader" || typeName.includes("Ornament") || typeName === "Restore Defaults" || name === "Default Shader" || name === "Default Ornament") categories.cosmetics.push(modObj);
      else if (name === "Upgrade Armor" || name.startsWith("Upgrade to")) categories.masterwork.push(modObj);
      else if (typeName === "" && !name.includes("Empty")) categories.archetype.push(modObj);
      else if (typeName === "Artifice Armor Mod" || (typeName === "General Armor Mod" && (name.includes("Tuning") || categories.statsAndTuning.length === 0))) categories.statsAndTuning.push(modObj);
      else if (typeName.includes("Armor Mod") && ["Helmet", "Arms", "Gauntlets", "Chest", "Leg", "Class Item"].some(p => typeName.startsWith(p))) categories.slotMods.push(modObj);
      else if (name === "") return;
      else if (typeName.includes("Mod") || typeName.includes("Raid") || typeName.includes("Nightmare") || typeName.includes("Activity")) categories.miscMods.push(modObj);
      else categories.intrinsic.push(modObj);
    });

    [...categories.statsAndTuning, ...categories.miscMods].forEach(def => {
      const name = def.displayProperties?.name || "";
      if (name.includes("/")) {
        const parts = name.split(" / ");
        parts.forEach(part => {
          if (part.startsWith("+")) {
            const stat = part.substring(1).trim();
            const hash = STAT_NAME_TO_HASH[stat];
            if (hash) categories.tuningMods[hash] += 5;
          } else if (part.startsWith("-")) {
            const stat = part.substring(1).trim();
            const hash = STAT_NAME_TO_HASH[stat];
            if (hash) categories.tuningMods[hash] -= 5;
          }
        });
        
        const match = name.match(/^\+([A-Za-z]+)\s*\//);
        if (match) categories.tuningStatName = match[1];

      } else if (name === "Balanced Tuning") {
        categories.hasBalancedTuning = true;
      } else if (name.endsWith(" Mod") && !name.includes("Empty")) {
        const isMinor = name.includes("Minor");
        const statMatch = Object.keys(STAT_NAME_TO_HASH).find(s => name.includes(s));
        if (statMatch) categories.statMods[STAT_NAME_TO_HASH[statMatch]] += isMinor ? 5 : 10;
      }
    });

    const isArmor3 = categories.archetype.length > 0;
    if (isArmor3 && targetItem) {
      const naturalStats = STAT_ORDER.map(hash => {
        const apiTotal = targetItem.stats[hash]?.value || 0;
        const sm = categories.statMods[hash] || 0;
        const tm = categories.tuningMods[hash] || 0;
        return { hash, val: apiTotal - sm - tm };
      });
      naturalStats.sort((a, b) => a.val - b.val);
      categories.zeroBaseHashes = naturalStats.slice(0, 3).map(obj => obj.hash);

      if (categories.hasBalancedTuning) {
        categories.zeroBaseHashes.forEach(hash => {
          categories.tuningMods[hash] += 1;
        });
      }
    }

    // Force load local storage override if available
    if (!categories.tuningStatName && targetItem) {
       try {
           const cache = JSON.parse(localStorage.getItem('d2_tuning_cache') || '{}');
           if (cache[targetItem.itemInstanceId]) {
               categories.tuningStatName = cache[targetItem.itemInstanceId];
           }
       } catch(e) {}
    }

    return categories;
  };

  const handleModClick = (targetItem, socketIndex, currentPlugHash) => {
    const liveSocket = targetItem.sockets[socketIndex];
    let hashes = [];
    
    if (liveSocket?.reusablePlugs && liveSocket.reusablePlugs.length > 0) {
        hashes = liveSocket.reusablePlugs.map(p => p.plugItemHash);
    } 
    if (hashes.length === 0) {
        const fullDef = manifest.items[targetItem.itemHash];
        const socketDef = fullDef?.sockets?.socketEntries?.[socketIndex];
        if (socketDef) {
            const plugSetHash = socketDef.reusablePlugSetHash || socketDef.randomizedPlugSetHash;
            if (plugSetHash) {
                const pData = manifest.plugSets[plugSetHash];
                if (pData?.reusablePlugItems) {
                    hashes = pData.reusablePlugItems.map(p => p.plugItemHash);
                }
            } else if (socketDef.reusablePlugItems) {
                hashes = socketDef.reusablePlugItems.map(p => p.plugItemHash);
            }
        }
    }
    
    hashes = [...new Set(hashes)];
    
    const isArmor = targetItem.definition.itemType === 2;
    let parsed = { tuningStatName: null };
    if (isArmor) parsed = parseSockets(targetItem);
    
    const tStat = parsed.tuningStatName;

    const fullMods = hashes.map(h => manifest.items[h]).filter(mod => {
        if (!mod) return false;
        const name = mod.displayProperties?.name || "";
        const rules = mod.plug?.insertionRules || [];
        if (rules.some(r => r.failureMessage?.includes("Seasonal Artifact"))) return false;

        // Force allow ALL tradeoff mods if we don't know the stat yet!
        if (isArmor && name.includes("/") && name.startsWith("+")) {
            if (tStat) return name.startsWith(`+${tStat}`);
            return true; // We are Unsure! Let the user try them all.
        }
        return true;
    });
    
    fullMods.sort((a, b) => {
       const isReset = (item) => {
           const n = item.displayProperties?.name || "";
           const t = item.itemTypeDisplayName || "";
           return n.includes("Empty") || n.includes("Default") || t === "Restore Defaults";
       };
       
       const aReset = isReset(a);
       const bReset = isReset(b);
       
       if (aReset && !bReset) return -1;
       if (!aReset && bReset) return 1;

       const cA = a.plug?.energyCost?.energyCost || 0;
       const cB = b.plug?.energyCost?.energyCost || 0;
       if (cA !== cB) return cA - cB;
       
       return (a.displayProperties?.name || "").localeCompare(b.displayProperties?.name || "");
    });
    
    setModSelector({ item: targetItem, socketIndex, activeModHash: currentPlugHash, mods: fullMods });
  };

  const renderModRow = (modArray, targetItem) => {
    if (modArray.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-2">
        {modArray.map((plugDef, idx) => (
          <div 
            key={`${plugDef.hash}-${idx}`} 
            onClick={() => handleModClick(targetItem, plugDef.socketIndex, plugDef.hash)}
            onMouseEnter={(e) => setTooltipData({ mod: plugDef, rect: e.currentTarget.getBoundingClientRect() })}
            onMouseLeave={() => setTooltipData(null)}
            className="relative group w-12 h-12 rounded bg-slate-950 border border-slate-700 hover:border-slate-400 transition-colors cursor-pointer"
          >
            <img 
              src={getBungieUrl(plugDef.displayProperties.icon)} 
              alt={plugDef.displayProperties.name} 
              className="w-full h-full object-cover rounded" 
            />
          </div>
        ))}
      </div>
    );
  };

  if (appState === 'idle') return null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500/30">
      
      {toastInfo && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 backdrop-blur-md text-white px-6 py-3 rounded-lg shadow-2xl z-[100] flex items-center gap-3 border transition-all animate-in slide-in-from-bottom-5 ${toastInfo.type === 'error' ? 'bg-red-600/95 border-red-500 shadow-[0_10px_40px_rgba(220,38,38,0.3)]' : 'bg-emerald-600/95 border-emerald-500 shadow-[0_10px_40px_rgba(16,185,129,0.3)]'}`}>
            {toastInfo.type === 'error' ? <AlertCircle className="w-5 h-5 shrink-0" /> : <CheckCircle className="w-5 h-5 shrink-0" />}
            <span className="font-semibold text-sm">{toastInfo.message}</span>
            <button onClick={() => setToastInfo(null)} className="ml-2 p-1 rounded-full transition-colors hover:bg-white/20"><X className="w-4 h-4" /></button>
        </div>
      )}

      {isActionLoading && (
        <div className="fixed inset-0 z-[999] bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center pointer-events-auto">
           <Loader2 className="w-16 h-16 text-indigo-500 animate-spin mb-4 drop-shadow-[0_0_15px_rgba(99,102,241,0.8)]" />
           <span className="text-white font-bold tracking-widest uppercase text-sm drop-shadow-md">Applying Changes...</span>
        </div>
      )}

      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-indigo-600 flex items-center justify-center">
              <span className="font-bold text-white tracking-tighter">D2</span>
            </div>
            <h1 className="font-semibold text-lg tracking-wide text-slate-200">Loadout Viewer</h1>
          </div>
          <div className="flex items-center gap-4">
              {appState === 'ready' && (
                 <>
                    <input type="file" accept=".csv" ref={fileInputRef} className="hidden" onChange={handleCsvUpload} />
                    <button 
                        onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full text-xs font-medium text-slate-300 transition-colors"
                    >
                        <Upload className="w-3.5 h-3.5" />
                        Upload DIM CSV
                    </button>
                 </>
              )}
              {workerStatus.active && (
                <div className="flex items-center gap-2 px-3 py-1 bg-indigo-500/10 border border-indigo-500/30 rounded-full text-xs font-medium text-indigo-300">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Scanning Vault... ({workerStatus.remaining})
                </div>
              )}
              {appState === 'ready' && (
                <div className="text-sm text-slate-400 font-medium">
                  {armorItems.length} Unequipped
                </div>
              )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {appState === 'login' && (
          <div className="flex flex-col items-center justify-center mt-24 space-y-6 max-w-md mx-auto text-center">
            <div className="p-4 bg-indigo-500/10 rounded-full">
              <LogIn className="w-12 h-12 text-indigo-400" />
            </div>
            <h2 className="text-3xl font-bold text-white">Connect to Bungie</h2>
            <p className="text-slate-400">
              Sign in with your Bungie.net account to securely access and view your Destiny 2 armor inventory across all characters and your vault.
            </p>
            <button
              onClick={loginToBungie}
              className="mt-4 px-8 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-semibold transition-all transform active:scale-95 shadow-lg shadow-indigo-600/20"
            >
              Authorize Account
            </button>
          </div>
        )}

        {(appState.startsWith('loading_')) && (
          <div className="flex flex-col items-center justify-center mt-32 space-y-4">
            <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
            <p className="text-slate-300 font-medium animate-pulse">
              {appState === 'loading_auth' && "Authenticating..."}
              {appState === 'loading_manifest' && "Downloading Full Database (this may take a moment)..."}
              {appState === 'loading_profile' && "Scanning Characters & Vault..."}
            </p>
          </div>
        )}

        {appState === 'error' && (
          <div className="flex flex-col items-center justify-center mt-24 space-y-4 text-center bg-red-950/30 p-8 rounded-2xl border border-red-900/50 max-w-lg mx-auto">
            <AlertCircle className="w-12 h-12 text-red-500" />
            <h3 className="text-xl font-bold text-red-200">Something went wrong</h3>
            <p className="text-red-400/80">{errorMsg}</p>
            <button
              onClick={() => setAppState('login')}
              className="mt-4 px-6 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-medium transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {/* READY / GRID STATE */}
        {appState === 'ready' && (
          <div className="space-y-10">
            <div className="flex space-x-2 border-b border-slate-800 pb-4 overflow-x-auto">
              {[0, 1, 2].map(classType => (
                <button
                  key={classType}
                  onClick={() => setSelectedClass(classType)}
                  className={`px-6 py-2 rounded-full font-semibold transition-colors whitespace-nowrap ${
                    selectedClass === classType 
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' 
                      : 'bg-slate-800/50 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  {CLASS_MAP[classType]}
                </button>
              ))}
            </div>

            {/* Character Banners for Selected Class */}
            {characters.filter(c => c.classType === selectedClass).map(char => (
              <div key={char.characterId} className="relative bg-slate-900 border border-slate-700 rounded-2xl p-4 overflow-hidden shadow-2xl flex flex-col md:items-stretch mb-8">
                <div className="absolute inset-0 opacity-30 bg-cover bg-center md:bg-right" style={{ backgroundImage: `url(${getBungieUrl(char.emblemBackgroundPath)})` }} />
                
                <div className="relative z-10 w-full flex flex-col md:flex-row gap-6 items-center md:items-stretch">
                    <div className="flex items-center gap-4 w-full md:w-auto">
                      <div className="w-16 h-16 rounded-lg shadow-lg border border-slate-600 overflow-hidden">
                        <img src={getBungieUrl(char.emblemPath)} alt="Emblem" className="w-full h-full object-cover" />
                      </div>
                      <div>
                        <h2 className="text-2xl font-black text-white drop-shadow-md">
                          <span className="text-amber-400 mr-1">✧</span>{char.light}
                        </h2>
                        <p className="text-sm font-medium text-slate-300 drop-shadow">{CLASS_MAP[char.classType]}</p>
                      </div>
                    </div>

                    <div className="flex-1 flex justify-center items-center w-full">
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-x-6 gap-y-2">
                        {STAT_ORDER.map(hash => (
                          <div key={hash} className="flex flex-col items-center">
                            <span className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">{STAT_MAP[hash]}</span>
                            <span className="text-sm font-black text-white drop-shadow-sm">{char.stats[hash]}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="flex gap-2 items-center md:border-l border-t md:border-t-0 border-slate-700/50 md:pl-6 pt-4 md:pt-0 mt-2 md:mt-0 w-full md:w-auto justify-center">
                      {char.equippedArmor.map((item, idx) => {
                         const def = item.definition;
                         const tierType = def.inventory?.tierType;
                         return (
                          <div 
                            key={idx} 
                            onClick={() => setSelectedItem(item)}
                            className={`w-12 h-12 rounded border-2 ${getTierColor(tierType)} cursor-pointer hover:scale-110 transition-transform shadow-lg group relative bg-slate-950`}
                          >
                            <img src={getBungieUrl(def.displayProperties.icon)} alt="icon" className="w-full h-full object-cover rounded-[1px]" />
                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity rounded-[1px]">
                               <Info className="w-5 h-5 text-white" />
                            </div>
                          </div>
                         )
                      })}
                    </div>
                </div>

                {/* Subclass Panel */}
                {char.subclass && (() => {
                   const subclassPlugs = char.subclass.sockets.map((socket, idx) => {
                       if (!socket.plugHash) return null;
                       const plugDef = manifest.items[socket.plugHash];
                       if (!plugDef) return null;
                       return { socket, plugDef, idx };
                   }).filter(Boolean);

                   const superPlugs = subclassPlugs.filter(p => p.plugDef.plug?.plugCategoryIdentifier?.includes("super"));
                   const abilityPlugs = subclassPlugs.filter(p => {
                        const pci = p.plugDef.plug?.plugCategoryIdentifier || "";
                        return pci.includes("melee") || pci.includes("grenade") || pci.includes("class");
                   });
                   const aspectPlugs = subclassPlugs.filter(p => p.plugDef.plug?.plugCategoryIdentifier?.includes("aspect"));
                   const fragmentPlugs = subclassPlugs.filter(p => p.plugDef.plug?.plugCategoryIdentifier?.includes("fragment") || p.plugDef.displayProperties.name.includes("Empty Fragment"));

                   const renderSubclassPlug = (p, isDiamond = false) => (
                       <div 
                         key={p.idx} 
                         onClick={() => handleModClick(char.subclass, p.idx, p.plugDef.hash)}
                         onMouseEnter={(e) => setTooltipData({ mod: p.plugDef, rect: e.currentTarget.getBoundingClientRect() })}
                         onMouseLeave={() => setTooltipData(null)}
                         className={`w-10 h-10 rounded border border-slate-600 hover:border-slate-300 cursor-pointer bg-slate-950/80 transition-all hover:scale-105 shadow-md flex items-center justify-center overflow-hidden
                           ${isDiamond ? "rounded-none rotate-45 scale-[0.8] hover:scale-[0.85] mx-1" : ""}
                         `}
                       >
                         {p.plugDef.displayProperties?.icon && (
                           <img src={getBungieUrl(p.plugDef.displayProperties.icon)} alt={p.plugDef.displayProperties.name} className={`w-full h-full object-cover ${isDiamond ? "-rotate-45 scale-[1.35]" : ""}`} />
                         )}
                       </div>
                   );

                   return (
                       <div className="relative z-10 w-full mt-4 pt-4 border-t border-slate-700/50 flex flex-wrap gap-4 items-center">
                         <div 
                            className="flex flex-col items-center gap-1 cursor-pointer group pr-4 border-r border-slate-700/50"
                            onClick={() => {
                               setModSelector({
                                   isSubclassSelector: true,
                                   characterId: char.characterId,
                                   activeModHash: char.subclass.itemHash,
                                   mods: char.unequippedSubclasses
                               });
                            }}
                         >
                           <span className="text-[9px] text-slate-500 uppercase tracking-widest font-bold group-hover:text-slate-300 transition-colors mb-1">Subclass</span>
                           <div className="w-9 h-9 border border-slate-600 group-hover:border-slate-300 transition-all rotate-45 overflow-hidden mb-1 shadow-md bg-slate-950">
                               <img src={getBungieUrl(char.subclass.definition.displayProperties.icon)} className="w-full h-full object-cover -rotate-45 scale-[1.35]" alt="Subclass" />
                           </div>
                         </div>
                         
                         <div className="flex flex-wrap gap-6 items-end">
                             {superPlugs.length > 0 && (
                                 <div className="flex flex-col gap-1.5 items-center">
                                     <span className="text-[9px] text-slate-500 uppercase tracking-widest font-bold mb-0.5">Super</span>
                                     <div className="flex gap-1.5 mt-1">{superPlugs.map(p => renderSubclassPlug(p, true))}</div>
                                 </div>
                             )}
                             {abilityPlugs.length > 0 && (
                                 <div className="flex flex-col gap-1.5">
                                     <span className="text-[9px] text-slate-500 uppercase tracking-widest font-bold">Abilities</span>
                                     <div className="flex gap-1.5">{abilityPlugs.map(p => renderSubclassPlug(p, false))}</div>
                                 </div>
                             )}
                             {aspectPlugs.length > 0 && (
                                 <div className="flex flex-col gap-1.5">
                                     <span className="text-[9px] text-slate-500 uppercase tracking-widest font-bold">Aspects</span>
                                     <div className="flex gap-1.5">{aspectPlugs.map(p => renderSubclassPlug(p, false))}</div>
                                 </div>
                             )}
                             {fragmentPlugs.length > 0 && (
                                 <div className="flex flex-col gap-1.5">
                                     <span className="text-[9px] text-slate-500 uppercase tracking-widest font-bold">Fragments</span>
                                     <div className="flex gap-1.5">{fragmentPlugs.map(p => renderSubclassPlug(p, false))}</div>
                                 </div>
                             )}
                         </div>
                       </div>
                   );
                })()}
              </div>
            ))}

            {/* Unequipped Slot Sections */}
            {Object.entries(SLOT_MAP).map(([slotHash, slotName]) => {
              const items = groupedArmor[selectedClass][slotHash] || [];
              if (items.length === 0) return null;

              return (
                <div key={slotHash} className="space-y-4">
                  <h3 className="text-xl font-bold text-slate-200 border-b border-slate-800/50 pb-2 flex items-baseline">
                    {slotName}
                    <span className="text-sm font-normal text-slate-500 ml-3">({items.length} Unequipped)</span>
                  </h3>
                  <div className="flex flex-wrap gap-2.5">
                    {items.map((item, idx) => {
                      const def = item.definition;
                      const iconUrl = getBungieUrl(def.displayProperties.icon);
                      const tierType = def.inventory?.tierType;
                      
                      return (
                        <div 
                          key={`${item.itemInstanceId}-${idx}`}
                          onClick={() => setSelectedItem(item)}
                          className={`w-12 h-12 rounded border-2 ${getTierColor(tierType)} cursor-pointer hover:scale-110 transition-transform shadow-lg group relative bg-slate-950`}
                        >
                          <img src={iconUrl} alt={def.displayProperties.name} className="w-full h-full object-cover rounded-[1px]" loading="lazy" />
                          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity rounded-[1px]">
                            <Info className="w-5 h-5 text-white" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            
            {Object.values(groupedArmor[selectedClass]).flat().length === 0 && (
              <div className="py-20 text-center text-slate-500">
                No unequipped armor pieces found for your {CLASS_MAP[selectedClass]}.
              </div>
            )}
          </div>
        )}
      </main>

      {/* Main Selected Item Modal */}
      {selectedItem && selectedItem.definition.itemType === 2 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={() => { setSelectedItem(null); setModSelector(null); }}>
          <div 
            className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden shadow-2xl max-w-2xl w-full flex flex-col max-h-[90vh] relative"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="relative h-32 bg-slate-800 flex items-end p-4 border-b-4 shrink-0" style={{ 
              borderBottomColor: 
                selectedItem.definition.inventory?.tierType === 6 ? '#eab308' :
                selectedItem.definition.inventory?.tierType === 5 ? '#a855f7' :
                selectedItem.definition.inventory?.tierType === 4 ? '#3b82f6' : '#64748b'
             }}>
               <div 
                 className="absolute inset-0 opacity-20 bg-cover bg-center"
                 style={{ backgroundImage: `url(${getBungieUrl(selectedItem.definition.displayProperties.icon)})`, filter: 'blur(10px)' }}
               />
               
               <div className="relative z-10 flex gap-4 items-end w-full">
                  <div className={`w-16 h-16 rounded border-2 ${getTierColor(selectedItem.definition.inventory?.tierType)} bg-slate-950 overflow-hidden shrink-0`}>
                    <img src={getBungieUrl(selectedItem.definition.displayProperties.icon)} alt="icon" className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0 pr-24">
                    <h2 className="text-xl font-bold text-white leading-tight truncate">
                      {selectedItem.definition.displayProperties.name}
                    </h2>
                    <p className="text-sm font-medium text-slate-300">
                      {selectedItem.definition.itemTypeDisplayName}
                    </p>
                  </div>
               </div>
               
               <div className="absolute top-4 right-4 flex gap-2 z-20">
                 {!characters.some(c => c.equippedArmor.some(a => a.itemInstanceId === selectedItem.itemInstanceId)) && (
                    <button 
                      onClick={() => equipItemAction(selectedItem.itemInstanceId, getTargetCharId(selectedItem))}
                      className="px-4 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded shadow-lg transition-colors flex items-center gap-1 uppercase tracking-wider"
                    >
                      Equip
                    </button>
                 )}
                 <button 
                   onClick={() => { setSelectedItem(null); setModSelector(null); }}
                   className="p-1 rounded-full bg-black/40 hover:bg-black/60 text-white transition-colors"
                 >
                   <X className="w-5 h-5" />
                 </button>
               </div>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar">
              
              <p className="text-slate-400 italic text-sm leading-relaxed border-l-2 border-slate-700 pl-4">
                "{selectedItem.definition.displayProperties.description || 'No description available.'}"
              </p>

              {(() => {
                const parsedSockets = parseSockets(selectedItem);
                const { masterwork, archetype, statsAndTuning, slotMods, miscMods, intrinsic, cosmetics, statMods, tuningMods, hasBalancedTuning, tuningStatName, zeroBaseHashes } = parsedSockets;
                
                const isArmor3 = archetype.length > 0;
                const finalTuningMods = { ...tuningMods };
                
                if (isArmor3 && hasBalancedTuning) {
                     zeroBaseHashes.forEach(hash => {
                       finalTuningMods[hash] += 1;
                     });
                }

                return (
                  <>
                    {/* Stats */}
                    {Object.keys(selectedItem.stats).length > 0 && (
                      <div className="pt-4 border-t border-slate-800/50">
                        <div className="flex flex-col gap-1.5 bg-slate-900/50 p-3 rounded-lg border border-slate-800/50">
                          {STAT_ORDER.map(hash => {
                            const name = STAT_MAP[hash];
                            const apiTotal = selectedItem.stats[hash]?.value || 0;
                            const statModValue = statMods[hash] || 0;
                            const tuningModValue = finalTuningMods[hash] || 0;
                            const naturalStat = apiTotal - statModValue - tuningModValue;

                            let mwValue = 0; let baseValue = 0;

                            if (isArmor3) {
                                if (zeroBaseHashes.includes(hash)) {
                                    mwValue = naturalStat; baseValue = 0;
                                } else {
                                    mwValue = 0; baseValue = naturalStat;
                                }
                            } else {
                                const energy = selectedItem.instanceData?.energy?.energyCapacity || 0;
                                mwValue = energy === 10 ? 2 : 0;
                                baseValue = Math.max(0, naturalStat - mwValue);
                            }
                            
                            const totalValue = apiTotal;
                            const penalty = Math.abs(tuningModValue < 0 ? tuningModValue : 0);
                            const bonus = statModValue + (tuningModValue > 0 ? tuningModValue : 0);

                            const isZero = totalValue === 0;
                            const isNegative = totalValue < 0;
                            
                            const isTuningStat = name === tuningStatName;
                            const isUnsureTuning = tuningStatName === null;
                            
                            const MAX_STAT = 42; 
                            const activeBase = Math.max(0, baseValue - penalty);
                            const activeMw = mwValue; 

                            return (
                              <div key={hash} className="group relative flex items-center text-[13px] leading-none cursor-default">
                                <div className="w-5 flex justify-center text-slate-300">
                                  {isTuningStat && <ChevronsUpDown className="w-4 h-4 text-sky-400" title={`Tuning Stat: Modifies tradeoffs for ${name}`} />}
                                  {isUnsureTuning && <ChevronsUpDown className="w-4 h-4 text-slate-600 opacity-50 cursor-help" title="Tuning Stat Unknown (Equip a tradeoff mod to reveal)" />}
                                </div>
                                
                                <span className={`w-20 text-right pr-2 ${!isZero ? 'font-bold' : ''} ${isNegative ? 'text-red-600' : 'text-white'}`}>
                                  {name}
                                </span>
                                <span className={`w-8 text-right font-mono ${!isZero ? 'font-bold' : ''} ${isNegative ? 'text-red-600' : 'text-white'}`}>
                                  {totalValue > 0 ? `+${totalValue}` : totalValue}
                                </span>
                                
                                <div className="w-6 flex justify-center opacity-70 ml-1">
                                   <div className="w-2 h-2 bg-slate-500 rounded-sm rotate-45"></div>
                                </div>

                                <div className="flex-1 bg-slate-800 h-3 flex items-center justify-start overflow-hidden ml-1 relative">
                                  {totalValue >= 0 && (
                                    <>
                                      {activeBase > 0 && <div className="bg-white h-full" style={{ width: `${(activeBase / MAX_STAT) * 100}%` }}></div>}
                                      {penalty > 0 && <div className="bg-red-800 h-full" style={{ width: `${(penalty / MAX_STAT) * 100}%` }}></div>}
                                      {activeMw > 0 && <div className="bg-amber-400 h-full shadow-[0_0_8px_rgba(251,191,36,0.8)] z-10" style={{ width: `${(activeMw / MAX_STAT) * 100}%` }}></div>}
                                      {bonus > 0 && <div className="bg-sky-400 h-full" style={{ width: `${(bonus / MAX_STAT) * 100}%` }}></div>}
                                    </>
                                  )}
                                  {totalValue < 0 && (
                                     <div className="bg-red-900/80 h-full absolute left-0 top-0" style={{ width: `${(Math.abs(totalValue) / MAX_STAT) * 100}%` }}></div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                          
                          {/* Totals & Energy */}
                          {(() => {
                            let totalBase = 0; let totalMw = 0; let totalStatMod = 0; let totalTuningMod = 0;

                            STAT_ORDER.forEach(hash => {
                                const apiTotal = selectedItem.stats[hash]?.value || 0;
                                const sm = statMods[hash] || 0;
                                const tm = finalTuningMods[hash] || 0;
                                const nat = apiTotal - sm - tm;
                                
                                if (isArmor3) {
                                    if (zeroBaseHashes.includes(hash)) totalMw += nat;
                                    else totalBase += nat;
                                } else {
                                    const energy = selectedItem.instanceData?.energy?.energyCapacity || 0;
                                    const mw = energy === 10 ? 2 : 0;
                                    totalMw += mw;
                                    totalBase += Math.max(0, nat - mw);
                                }
                                totalStatMod += sm; totalTuningMod += tm;
                            });
                            
                            const overallTotal = totalBase + totalMw + totalStatMod + totalTuningMod;
                            const allModsSum = totalStatMod + totalTuningMod;
                            const energyInfo = selectedItem.instanceData?.energy;
                            
                            return (
                              <>
                                <div className="flex items-center text-[13px] leading-none mt-1">
                                  <div className="w-5"></div>
                                  <span className="w-20 text-right pr-2 text-white font-bold">Total</span>
                                  <div className="w-8 flex flex-col items-end">
                                    <div className="w-6 border-t border-white mb-1"></div>
                                    <span className="text-white font-bold font-mono">{overallTotal}</span>
                                  </div>
                                  <div className="flex-1 ml-8 flex items-center gap-1.5 font-mono text-xs">
                                    {allModsSum !== 0 && (
                                      <>
                                        <span className="text-slate-400">{totalBase + totalMw}</span>
                                        <span className={allModsSum > 0 ? "text-sky-400 font-medium" : "text-red-500 font-medium"}>
                                          {allModsSum > 0 ? '+' : ''}{allModsSum}
                                        </span>
                                      </>
                                    )}
                                  </div>
                                </div>

                                {energyInfo && (
                                  <div className="flex items-center text-[13px] leading-none mt-4 pt-4 border-t border-slate-700/50">
                                    <div className="w-5"></div>
                                    <span className="w-20 text-right pr-2 text-white font-bold">Energy</span>
                                    <div className="w-8 flex flex-col items-end">
                                      <span className="text-white font-bold font-mono">{energyInfo.energyUsed}</span>
                                    </div>
                                    <div className="flex-1 ml-8 flex items-center gap-0.5 relative group cursor-default">
                                      <div className="absolute left-1/2 bottom-full mb-2 -translate-x-1/2 w-max px-3 py-1.5 bg-slate-800 border border-slate-600 rounded text-xs shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-20 font-medium text-white flex gap-3">
                                         <span className="text-sky-400">{energyInfo.energyUsed} Used</span>
                                         <span className="text-slate-300">{energyInfo.energyCapacity - energyInfo.energyUsed} Free</span>
                                         <span className="text-slate-500">{Math.max(0, 10 - energyInfo.energyCapacity)} Locked</span>
                                      </div>

                                      {[...Array(Math.max(10, energyInfo.energyCapacity))].map((_, i) => {
                                        const isUsed = i < energyInfo.energyUsed;
                                        const isAvail = i >= energyInfo.energyUsed && i < energyInfo.energyCapacity;
                                        
                                        let bgClass = "bg-slate-900 border-slate-800";
                                        if (isUsed) bgClass = "bg-sky-500 border-sky-400 shadow-[0_0_8px_rgba(14,165,233,0.5)]";
                                        else if (isAvail) bgClass = "bg-slate-600 border-slate-500";
                                        
                                        return <div key={`eng-${i}`} className={`h-3.5 flex-1 rounded-[1px] border ${bgClass} transition-colors`}></div>
                                      })}
                                    </div>
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    )}

                    {/* Archetype Banner */}
                    {(archetype.length > 0 || intrinsic.length > 0) && (
                      <div className="pt-2 space-y-2">
                        {archetype.map((def, idx) => {
                          const rawDesc = def.displayProperties.description || '';
                          const statLines = rawDesc.split('\n').filter(line => line.includes('Stat:'));
                          
                          return (
                            <div key={`arch-${idx}`} className="flex items-center gap-3 py-1">
                              <div className="relative w-10 h-10 flex items-center justify-center shrink-0">
                                <img src={getBungieUrl(def.displayProperties.icon)} alt={def.displayProperties.name} className="w-full h-full object-contain" />
                              </div>
                              <div className="flex flex-col">
                                <h4 className="text-sm font-bold text-slate-200">{def.displayProperties.name}</h4>
                                {statLines.map((line, i) => (
                                  <p key={i} className="text-[11px] text-slate-400 font-medium">{line}</p>
                                ))}
                              </div>
                            </div>
                          );
                        })}

                        {intrinsic.map((def, idx) => {
                           let descText = getModDescription(def);
                           return (
                              <div key={`intr-${idx}`} className="flex items-start gap-3 py-1">
                                <div className="relative w-10 h-10 flex items-center justify-center shrink-0 bg-slate-900 rounded border border-slate-700/50 p-1">
                                  <img src={getBungieUrl(def.displayProperties.icon)} alt={def.displayProperties.name} className="w-full h-full object-contain" />
                                </div>
                                <div className="flex flex-col">
                                  <h4 className="text-sm font-bold text-amber-400">{def.displayProperties.name}</h4>
                                  <p className="text-[11px] text-slate-400 font-medium leading-relaxed mt-0.5 whitespace-pre-wrap">{descText}</p>
                                </div>
                              </div>
                           );
                        })}
                      </div>
                    )}

                    {/* Sets */}
                    {(() => {
                      const setHash = selectedItem.definition.equippingBlock?.equipableItemSetHash;
                      if (!setHash || !manifest.sets || !manifest.sets[setHash]) return null;
                      
                      const setDef = manifest.sets[setHash];
                      if (!setDef.setPerks || setDef.setPerks.length === 0) return null;
                      
                      return (
                        <div className="space-y-1 mt-2">
                          {setDef.setPerks.map((perkObj, idx) => {
                            const perkDef = manifest.perks[perkObj.sandboxPerkHash];
                            if (!perkDef) return null;
                            return (
                              <div key={`set-${idx}`} className="flex items-start gap-3 py-1.5 bg-emerald-950/20 border border-emerald-900/30 rounded-lg p-3">
                                <div className="flex flex-col">
                                  <h4 className="text-[13px] font-bold text-emerald-400">{perkObj.requiredSetCount}-Piece Set: {perkDef.displayProperties?.name}</h4>
                                  <p className="text-[11px] text-emerald-100/70 font-medium leading-relaxed mt-0.5 whitespace-pre-wrap">
                                    {perkDef.displayProperties?.description}
                                  </p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}

                    {/* Sockets / Mods */}
                    {(() => {
                      const hasGridMods = masterwork.length > 0 || statsAndTuning.length > 0 || slotMods.length > 0 || miscMods.length > 0 || cosmetics.length > 0;
                      if (!hasGridMods) return null;

                      return (
                        <div className="pt-4 border-t border-slate-800/50">
                          <h4 className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-3">Sockets & Mods</h4>
                          <p className="text-[10px] text-slate-500 italic mb-3 -mt-2">Click any mod to view alternatives and energy costs.</p>
                          <div className="flex flex-col gap-4 bg-slate-900/30 p-4 rounded-lg border border-slate-800/50">
                            {masterwork.length > 0 && (
                              <div>
                                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Masterwork Status</span>
                                {renderModRow(masterwork, selectedItem)}
                              </div>
                            )}
                            {statsAndTuning.length > 0 && (
                              <div>
                                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Stat Mods</span>
                                {renderModRow(statsAndTuning, selectedItem)}
                              </div>
                            )}
                            {slotMods.length > 0 && (
                              <div>
                                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Armor Mods</span>
                                {renderModRow(slotMods, selectedItem)}
                              </div>
                            )}
                            {miscMods.length > 0 && (
                              <div>
                                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Activity & Misc Mods</span>
                                {renderModRow(miscMods, selectedItem)}
                              </div>
                            )}
                            {cosmetics.length > 0 && (
                              <div>
                                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Cosmetics</span>
                                {renderModRow(cosmetics, selectedItem)}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                );
              })()}
              
              <div className="pt-4 border-t border-slate-800/50">
                <h4 className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-3">Technical Details</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="bg-slate-950/50 p-2 rounded">
                    <span className="block text-slate-500 text-xs">Item Hash</span>
                    <span className="font-mono text-slate-300 truncate block" title={selectedItem.itemHash}>{selectedItem.itemHash}</span>
                  </div>
                  <div className="bg-slate-950/50 p-2 rounded">
                    <span className="block text-slate-500 text-xs">Tier</span>
                    <span className="text-slate-300">{selectedItem.definition.inventory?.tierTypeName || 'Unknown'}</span>
                  </div>
                  <div className="bg-slate-950/50 p-2 rounded col-span-2">
                    <span className="block text-slate-500 text-xs">Instance ID</span>
                    <span className="font-mono text-slate-300 truncate block" title={selectedItem.itemInstanceId}>{selectedItem.itemInstanceId || 'N/A (Not Instanced)'}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mod Selector Panel */}
      {modSelector && (() => {
           const isSubclass = modSelector.isSubclassSelector || modSelector.item?.definition?.itemType === 16;
           const displayMods = modSelector.mods;
           const activeModDef = isSubclass ? manifest.items[modSelector.activeModHash] : manifest.items[modSelector.activeModHash];
           const activeModCost = activeModDef?.plug?.energyCost?.energyCost || 0;
           
           const energyInfo = modSelector.item?.instanceData?.energy;
           let availableEnergy = 999;
           
           if (!isSubclass && energyInfo) {
              const energyCapacity = energyInfo.energyCapacity || 0;
              const energyUsed = energyInfo.energyUsed || 0;
              availableEnergy = energyCapacity - energyUsed + activeModCost;
           }

           return (
             <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setModSelector(null)}>
               <div className="bg-slate-900 flex flex-col rounded-xl overflow-hidden max-w-3xl w-full max-h-[85vh] shadow-2xl border border-slate-700" onClick={e => e.stopPropagation()}>
                 <div className="h-14 bg-slate-800 flex items-center justify-between px-4 border-b border-slate-700 shrink-0">
                     <h3 className="text-sm font-bold text-white uppercase tracking-wider">Select Option</h3>
                     <div className="flex items-center gap-4">
                         {!isSubclass && energyInfo && (
                           <div className="text-xs font-medium text-slate-400 flex items-center gap-2">
                              <span>Avail. Energy:</span>
                              <span className="text-sky-400 font-mono font-bold text-sm bg-slate-950 px-2 py-0.5 rounded border border-slate-700">{availableEnergy}</span>
                           </div>
                         )}
                         <button onClick={() => setModSelector(null)} className="p-1 rounded-full bg-slate-700 hover:bg-slate-600 text-white transition-colors">
                             <X className="w-5 h-5"/>
                         </button>
                     </div>
                 </div>

                 <div className="p-4 overflow-y-auto custom-scrollbar flex-1 bg-slate-950 pb-32">
                     {displayMods.length === 0 ? (
                        <div className="text-center text-slate-500 italic pt-10">No alternative options available for this slot.</div>
                     ) : (
                        <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 gap-3">
                            {displayMods.map((modItem, idx) => {
                                const mod = isSubclass && modSelector.isSubclassSelector ? modItem.definition : modItem;
                                const modHash = isSubclass && modSelector.isSubclassSelector ? modItem.itemHash : mod.hash;
                                
                                const cost = mod.plug?.energyCost?.energyCost || 0;
                                const isEquipped = modHash === modSelector.activeModHash;
                                const isEquippable = isSubclass ? true : cost <= availableEnergy;
                                
                                const isSuper = mod.plug?.plugCategoryIdentifier?.includes("super");
                                const isSubclassItem = isSubclass && modSelector.isSubclassSelector;
                                const isDiamond = isSuper || isSubclassItem;
                                
                                return (
                                    <div 
                                      key={`${modHash}-${idx}`} 
                                      className={`relative group aspect-square rounded cursor-pointer transition-all hover:z-50 flex items-center justify-center
                                         ${!isEquippable && !isEquipped ? 'opacity-30 grayscale cursor-not-allowed' : ''}
                                         ${isDiamond ? 'scale-[0.8] hover:scale-[0.85]' : ''}
                                      `}
                                      onMouseEnter={(e) => setTooltipData({ mod, rect: e.currentTarget.getBoundingClientRect() })}
                                      onMouseLeave={() => setTooltipData(null)}
                                      onClick={() => {
                                          if (isEquipped) return;
                                          if (!isEquippable) {
                                              setToastInfo({ message: `Requires ${cost} Energy. You only have ${availableEnergy} available.`, type: 'error' });
                                              return;
                                          }
                                          if (modSelector.isSubclassSelector) {
                                              equipItemAction(modItem.itemInstanceId, modSelector.characterId);
                                          } else {
                                              equipModAction(modSelector.item.itemInstanceId, modSelector.socketIndex, modHash, getTargetCharId(modSelector.item));
                                          }
                                      }}
                                    >
                                        <div className={`w-full h-full border-2 overflow-hidden relative transition-colors flex items-center justify-center
                                            ${isDiamond ? 'rotate-45' : 'rounded'}
                                            ${isEquipped ? 'border-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.5)]' : 'border-slate-700 group-hover:border-slate-400'}
                                        `}>
                                            <img src={getBungieUrl(mod.displayProperties.icon)} alt={mod.displayProperties.name} className={`w-full h-full object-cover ${isDiamond ? '-rotate-45 scale-[1.35]' : ''}`} />
                                            
                                            {cost > 0 && !isDiamond && !isSubclass && (
                                                <div className={`absolute top-0 right-0 bg-slate-900/90 border-b border-l border-slate-700 text-[10px] font-bold px-1.5 py-0.5 rounded-bl backdrop-blur-sm z-10 ${isEquippable || isEquipped ? 'text-sky-400' : 'text-red-400'}`}>
                                                    {cost}
                                                </div>
                                            )}
                                            {isEquipped && (
                                                <div className="absolute inset-0 bg-sky-400/20 z-0"></div>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                     )}
                 </div>
               </div>
             </div>
           );
      })()}

      {/* Global Tooltips */}
      {tooltipData && (
        <div 
          className="fixed z-[9999] w-max max-w-[280px] p-3 bg-slate-800 border border-slate-700 text-xs text-slate-200 rounded-lg shadow-2xl pointer-events-none"
          style={(() => {
            const rect = tooltipData.rect;
            const style = {};
            const isBottomHalf = rect.top > window.innerHeight / 2;
            const isRightHalf = rect.left > window.innerWidth / 2;
            
            if (isBottomHalf) style.bottom = (window.innerHeight - rect.top) + 8 + 'px';
            else style.top = rect.bottom + 8 + 'px';
            
            if (isRightHalf) style.right = (window.innerWidth - rect.right) + 'px';
            else style.left = rect.left + 'px';
            
            return style;
          })()}
        >
          <span className="font-bold text-slate-100 block mb-1">{tooltipData.mod.displayProperties.name}</span>
          <span className={`text-[10px] text-slate-400 block ${getModDescription(tooltipData.mod) || (tooltipData.mod.investmentStats && tooltipData.mod.investmentStats.length > 0) ? 'mb-2 pb-2 border-b border-slate-700/50' : ''}`}>
            {tooltipData.mod.itemTypeDisplayName || 'Upgrade / Modifier'}
          </span>
          {getModDescription(tooltipData.mod) && (
            <span className="text-[11px] text-slate-300 leading-relaxed block text-left whitespace-pre-wrap">
              {getModDescription(tooltipData.mod)}
            </span>
          )}
          {tooltipData.mod.investmentStats && tooltipData.mod.investmentStats.length > 0 && (
             <div className="mt-1.5 pt-1.5 border-t border-slate-700/50 flex flex-col gap-0.5">
               {tooltipData.mod.investmentStats.map((stat, i) => {
                  const statName = STAT_MAP[stat.statTypeHash];
                  if (!statName) return null; 
                  return (
                     <span key={i} className={`text-[11px] font-bold ${stat.value > 0 ? 'text-green-400' : 'text-red-400'}`}>
                       {stat.value > 0 ? '+' : ''}{stat.value} {statName}
                     </span>
                  );
               })}
             </div>
          )}
        </div>
      )}

    </div>
  );
}