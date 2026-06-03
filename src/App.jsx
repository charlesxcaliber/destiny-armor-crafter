import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, X, AlertCircle, LogIn, Info, ChevronsUpDown } from 'lucide-react';

// --- CONFIGURATION ---
const CLIENT_ID = '52410'; 
const API_KEY = 'd7873948e4c74594845880f5aafa9b81'; 
const REDIRECT_URI = window.location.origin + window.location.pathname;

// Helper to construct Bungie URLs
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

// Destiny 2 stat hashes for armor (Updated for Edge of Fate)
const STAT_MAP = {
  2996146975: 'Weapons',
  392767087: 'Health',
  1943323491: 'Class',
  1735777505: 'Grenade',
  4244567218: 'Melee',
  144602215: 'Super'
};

// Inverse map for parsing Edge of Fate Mod names
const STAT_NAME_TO_HASH = {
  'Weapons': 2996146975,
  'Health': 392767087,
  'Class': 1943323491,
  'Grenade': 1735777505,
  'Melee': 4244567218,
  'Super': 144602215
};

// Specific ordering for the UI bars
const STAT_ORDER = [
  392767087,  // Health
  4244567218, // Melee
  1735777505, // Grenade
  144602215,  // Super
  1943323491, // Class
  2996146975  // Weapons
];

export default function App() {
  // --- STATE ---
  const [appState, setAppState] = useState('idle'); // idle, login, loading_manifest, loading_auth, loading_profile, ready, error
  const [errorMsg, setErrorMsg] = useState(null);
  
  const [manifest, setManifest] = useState(null);
  const [armorItems, setArmorItems] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedClass, setSelectedClass] = useState(0); // 0: Titan, 1: Hunter, 2: Warlock
  
  // Specific state for dynamic Set Bonus data since it lives outside the Lite manifest
  const [selectedSetBonus, setSelectedSetBonus] = useState(null); 

  // --- TEMPORARY DEBUG EXPOSURE ---
  useEffect(() => {
    window.__D2_MANIFEST = manifest;
    window.__D2_SELECTED_ITEM = selectedItem;
  }, [manifest, selectedItem]);

  // Group the flat armor list by Class -> Slot
  const groupedArmor = useMemo(() => {
    const groups = {
      0: { 45: [], 46: [], 47: [], 48: [], 49: [] },
      1: { 45: [], 46: [], 47: [], 48: [], 49: [] },
      2: { 45: [], 46: [], 47: [], 48: [], 49: [] },
    };

    armorItems.forEach(item => {
      const cType = item.definition.classType;
      // Destiny API classType mapping: 0=Titan, 1=Hunter, 2=Warlock
      if (groups[cType]) {
        const cats = item.definition.itemCategoryHashes || [];
        // Find which armor slot category hash this item has
        const slot = [45, 46, 47, 48, 49].find(h => cats.includes(h));
        if (slot) {
          groups[cType][slot].push(item);
        }
      }
    });

    return groups;
  }, [armorItems]);

  // --- INITIALIZATION & AUTH CHECK ---
  useEffect(() => {
    const initialize = async () => {
      // 1. Check for auth code in URL
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');

      if (code) {
        // Clean URL so the code doesn't linger
        window.history.replaceState({}, document.title, window.location.pathname);
        await processAuthFlow(code);
      } else {
        setAppState('login');
      }
    };

    initialize();
  }, []);

  // --- SET BONUS FETCHER ---
  // When an item is clicked, check if it has a set hash and fetch the detailed perks
  useEffect(() => {
    if (!selectedItem) {
      setSelectedSetBonus(null);
      return;
    }

    const fetchSetBonus = async () => {
      const setHash = selectedItem.definition?.equippingBlock?.equipableItemSetHash;
      if (!setHash || setHash === 0) return;

      try {
        // Fetch the Set Definition
        const setRes = await fetch(`${BUNGIE_ROOT}/Platform/Destiny2/Manifest/DestinyEquipableItemSetDefinition/${setHash}/`, {
          headers: { 'X-API-Key': API_KEY }
        });
        const setDef = (await setRes.json()).Response;
        
        if (setDef && setDef.setPerks && setDef.setPerks.length > 0) {
          const perksWithDefs = await Promise.all(setDef.setPerks.map(async (perkObj) => {
            const perkRes = await fetch(`${BUNGIE_ROOT}/Platform/Destiny2/Manifest/DestinySandboxPerkDefinition/${perkObj.sandboxPerkHash}/`, {
              headers: { 'X-API-Key': API_KEY }
            });
            const perkDef = (await perkRes.json()).Response;
            return {
              count: perkObj.requiredSetCount,
              name: perkDef?.displayProperties?.name || "Unknown Perk",
              description: perkDef?.displayProperties?.description || "",
              icon: perkDef?.displayProperties?.icon
            };
          }));
          
          setSelectedSetBonus({
             name: setDef.displayProperties?.name,
             perks: perksWithDefs.sort((a, b) => a.count - b.count)
          });
        }
      } catch (err) {
        console.error("Failed to fetch set bonus data:", err);
      }
    };

    fetchSetBonus();
  }, [selectedItem]);


  // --- CORE LOGIC ---

  const processAuthFlow = async (code) => {
    try {
      setAppState('loading_auth');
      
      // 1. Exchange code for token
      const tokenData = await fetchToken(code);
      if (!tokenData || !tokenData.access_token) throw new Error("Failed to authenticate with Bungie.");
      
      setAppState('loading_manifest');
      
      // 2. Fetch Manifest (we need this to identify armor)
      const manifestData = await fetchManifest();
      setManifest(manifestData);

      setAppState('loading_profile');

      // 3. Get Memberships for the authenticated user
      const memberships = await fetchMemberships(tokenData.access_token);
      if (!memberships || memberships.length === 0) throw new Error("No Destiny 2 memberships found for this account.");
      
      // Prefer primary membership, or fallback to the first one
      const primaryMembership = memberships.find(m => m.membershipId === memberships.primaryMembershipId) || memberships[0];

      // 4. Fetch Profile (Vault, Character Inventory, Character Equipment)
      const profileData = await fetchProfile(primaryMembership.membershipType, primaryMembership.membershipId, tokenData.access_token);
      
      // 5. Process and filter armor
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

  // --- API CALLS ---

  const fetchToken = async (code) => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: code
    });

    const response = await fetch(`${BUNGIE_ROOT}/Platform/App/OAuth/Token/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString()
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error_description || "Authentication failed.");
    return data;
  };

  const fetchManifest = async () => {
    // 1. Get Manifest links
    const res = await fetch(`${BUNGIE_ROOT}/Platform/Destiny2/Manifest/`, {
      headers: { 'X-API-Key': API_KEY }
    });
    const manifestInfo = await res.json();
    
    // 2. Fetch the Item Definition JSON (using Lite if available to save massive bandwidth, fallback to full)
    const paths = manifestInfo.Response.jsonWorldComponentContentPaths.en;
    const itemDefPath = paths.DestinyInventoryItemLiteDefinition || paths.DestinyInventoryItemDefinition;
    
    const defRes = await fetch(getBungieUrl(itemDefPath));
    return await defRes.json();
  };

  const fetchMemberships = async (token) => {
    const res = await fetch(`${BUNGIE_ROOT}/Platform/User/GetMembershipsForCurrentUser/`, {
      headers: {
        'X-API-Key': API_KEY,
        'Authorization': `Bearer ${token}`
      }
    });
    const data = await res.json();
    return data.Response.destinyMemberships;
  };

  const fetchProfile = async (membershipType, membershipId, token) => {
    // Components: 
    // 102 (Vault), 201 (Character Inventories), 205 (Character Equipment)
    // 300 (ItemInstances), 304 (ItemStats), 305 (ItemSockets)
    const res = await fetch(`${BUNGIE_ROOT}/Platform/Destiny2/${membershipType}/Profile/${membershipId}/?components=102,201,205,300,304,305`, {
      headers: {
        'X-API-Key': API_KEY,
        'Authorization': `Bearer ${token}`
      }
    });
    const data = await res.json();
    return data.Response;
  };

  const processInventory = (profile, manifestDb) => {
    let allItems = [];

    // 1. Vault Items
    if (profile.profileInventory?.data?.items) {
      allItems = [...allItems, ...profile.profileInventory.data.items];
    }
    
    // 2. Character Inventories
    if (profile.characterInventories?.data) {
      Object.values(profile.characterInventories.data).forEach(char => {
        allItems = [...allItems, ...char.items];
      });
    }

    // 3. Equipped Items
    if (profile.characterEquipment?.data) {
      Object.values(profile.characterEquipment.data).forEach(char => {
        allItems = [...allItems, ...char.items];
      });
    }

    // 4. Map to Definitions, Stats, Sockets and Filter Armor (itemType === 2)
    const armorList = allItems.reduce((acc, item) => {
      const def = manifestDb[item.itemHash];
      if (def && def.itemType === 2) { // 2 corresponds to Armor in Bungie API
        const instanceId = item.itemInstanceId;
        
        // Extract instance-specific data if available
        const stats = instanceId && profile.itemComponents?.stats?.data?.[instanceId]?.stats;
        const sockets = instanceId && profile.itemComponents?.sockets?.data?.[instanceId]?.sockets;
        const instanceData = instanceId && profile.itemComponents?.instances?.data?.[instanceId];

        acc.push({
          ...item,
          definition: def,
          stats: stats || {},
          sockets: sockets || [],
          instanceData: instanceData || {}
        });
      }
      return acc;
    }, []);

    // Sort by tier type (Exotic first) then name
    armorList.sort((a, b) => {
      const tierDiff = (b.definition.inventory?.tierType || 0) - (a.definition.inventory?.tierType || 0);
      if (tierDiff !== 0) return tierDiff;
      return a.definition.displayProperties.name.localeCompare(b.definition.displayProperties.name);
    });

    setArmorItems(armorList);
  };

  // --- UI HELPERS ---

  const getTierColor = (tierType) => {
    switch (tierType) {
      case 6: return 'border-yellow-500 shadow-[0_0_10px_rgba(234,179,8,0.5)]'; // Exotic
      case 5: return 'border-purple-500 shadow-[0_0_10px_rgba(168,85,247,0.5)]'; // Legendary
      case 4: return 'border-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]'; // Rare
      case 3: return 'border-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]'; // Uncommon
      default: return 'border-gray-500 shadow-sm'; // Common/Unknown
    }
  };

  // Parse sockets dynamically using manifest definitions & Edge of Fate Name Parsing
  const parseSockets = (sockets) => {
    const categories = {
      masterwork: [],
      archetype: [],
      statsAndTuning: [],
      slotMods: [],
      intrinsic: [],
      cosmetics: [],
      statMods: {
        2996146975: 0, 392767087: 0, 1943323491: 0,
        1735777505: 0, 4244567218: 0, 144602215: 0
      },
      tuningMods: {
        2996146975: 0, 392767087: 0, 1943323491: 0,
        1735777505: 0, 4244567218: 0, 144602215: 0
      },
      hasBalancedTuning: false
    };

    if (!sockets) return categories;

    sockets.forEach((socket, idx) => {
      if (!socket.plugHash) return;
      const def = manifest[socket.plugHash];
      if (!def || !def.displayProperties || !def.displayProperties.name) return;

      const name = def.displayProperties.name;
      const typeName = def.itemTypeDisplayName || "";
      const subType = def.itemSubType;

      // Slot 6 filtering: Extract Masterwork/Upgrade socket
      if (name === "Upgrade Armor" || name.startsWith("Upgrade to")) {
        categories.masterwork.push(def);
        return;
      }

      // Slot 7: Armor Archetype (has no type name, but isn't a cosmetic)
      if (typeName === "" && name !== "Default Ornament" && !name.includes("Empty")) {
        categories.archetype.push(def);
      } 
      // Slot 1 & Artifice/Tuning Mod: General Stat Mods
      else if (typeName === "General Armor Mod" || typeName === "Artifice Armor Mod") {
        categories.statsAndTuning.push(def);
      } 
      // Slots 2-4: Slot Specific Armor Mods
      else if (typeName.includes("Armor Mod")) {
        categories.slotMods.push(def);
      } 
      // Slots 5 & 11: Cosmetics (Shaders and Ornaments)
      else if (subType === 20 || subType === 21 || typeName === "Shader" || typeName.includes("Ornament") || typeName === "Restore Defaults") {
        categories.cosmetics.push(def);
      } 
      // Slot 9 (12/11 depending on era): Exotic Trait/Intrinsic
      else {
        categories.intrinsic.push(def);
      }
    });

    // --- EDGE OF FATE CUSTOM STAT PARSER ---
    categories.statsAndTuning.forEach(def => {
      const name = def.displayProperties?.name || "";
      
      // Handle Hybrid Mods (e.g., "+Super / -Class")
      if (name.includes("/")) {
        const parts = name.split(" / ");
        parts.forEach(part => {
          if (part.startsWith("+")) {
            const stat = part.substring(1).trim();
            const hash = STAT_NAME_TO_HASH[stat];
            // Corrected to grant +5
            if (hash) categories.tuningMods[hash] += 5; 
          } else if (part.startsWith("-")) {
            const stat = part.substring(1).trim();
            const hash = STAT_NAME_TO_HASH[stat];
            if (hash) categories.tuningMods[hash] -= 5;
          }
        });
      } 
      // Handle Balanced Tuning (Dynamically targets zero-base stats)
      else if (name === "Balanced Tuning") {
        categories.hasBalancedTuning = true;
      }
      // Handle Standard Stat Mods (e.g., "Health Mod", "Minor Super Mod")
      else if (name.endsWith(" Mod") && !name.includes("Empty")) {
        const isMinor = name.includes("Minor");
        const stat = name.replace("Minor", "").replace("Major", "").replace("Mod", "").trim();
        const hash = STAT_NAME_TO_HASH[stat];
        if (hash) categories.statMods[hash] += isMinor ? 5 : 10;
      }
    });

    return categories;
  };

  const renderModRow = (modArray) => {
    if (modArray.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-2">
        {modArray.map((plugDef, idx) => (
          <div key={`${plugDef.hash}-${idx}`} className="relative group w-12 h-12 rounded bg-slate-950 border border-slate-700 hover:border-slate-500 transition-colors cursor-help">
            <img 
              src={getBungieUrl(plugDef.displayProperties.icon)} 
              alt={plugDef.displayProperties.name} 
              className="w-full h-full object-cover" 
            />
            {/* Mod Name Tooltip */}
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max max-w-[200px] text-center px-3 py-1.5 bg-slate-800 border border-slate-700 text-xs text-slate-200 rounded shadow-lg opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10">
              <span className="font-semibold block mb-0.5">{plugDef.displayProperties.name}</span>
              <span className="text-[10px] text-slate-400">{plugDef.itemTypeDisplayName || 'Upgrade / Masterwork'}</span>
            </div>
          </div>
        ))}
      </div>
    );
  };

  // --- RENDER ---

  if (appState === 'idle') return null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500/30">
      
      {/* HEADER */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-indigo-600 flex items-center justify-center">
              <span className="font-bold text-white tracking-tighter">D2</span>
            </div>
            <h1 className="font-semibold text-lg tracking-wide text-slate-200">Armor Viewer</h1>
          </div>
          {appState === 'ready' && (
            <div className="text-sm text-slate-400 font-medium">
              {armorItems.length} Armor Pieces Found
            </div>
          )}
        </div>
      </header>

      {/* MAIN CONTENT AREA */}
      <main className="max-w-7xl mx-auto px-4 py-8">
        
        {/* LOGIN STATE */}
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

        {/* LOADING STATES */}
        {(appState.startsWith('loading_')) && (
          <div className="flex flex-col items-center justify-center mt-32 space-y-4">
            <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
            <p className="text-slate-300 font-medium animate-pulse">
              {appState === 'loading_auth' && "Authenticating..."}
              {appState === 'loading_manifest' && "Downloading Item Database (this may take a moment)..."}
              {appState === 'loading_profile' && "Scanning Characters & Vault..."}
            </p>
          </div>
        )}

        {/* ERROR STATE */}
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
            {/* Class Tabs */}
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

            {/* Slot Sections */}
            {Object.entries(SLOT_MAP).map(([slotHash, slotName]) => {
              const items = groupedArmor[selectedClass][slotHash] || [];
              if (items.length === 0) return null;

              return (
                <div key={slotHash} className="space-y-4">
                  <h3 className="text-xl font-bold text-slate-200 border-b border-slate-800/50 pb-2 flex items-baseline">
                    {slotName}
                    <span className="text-sm font-normal text-slate-500 ml-3">({items.length})</span>
                  </h3>
                  <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 gap-2">
                    {items.map((item, idx) => {
                      const def = item.definition;
                      const iconUrl = getBungieUrl(def.displayProperties.icon);
                      const tierType = def.inventory?.tierType;
                      
                      return (
                        <div 
                          key={`${item.itemInstanceId}-${idx}`}
                          onClick={() => setSelectedItem(item)}
                          className={`
                            relative aspect-square bg-slate-800 rounded-md cursor-pointer 
                            overflow-hidden border-2 transition-all duration-200
                            hover:scale-105 hover:z-10 group
                            ${getTierColor(tierType)}
                          `}
                        >
                          <img 
                            src={iconUrl} 
                            alt={def.displayProperties.name}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                          {/* Hover Overlay */}
                          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                            <Info className="w-6 h-6 text-white" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            
            {/* Empty State for selected class */}
            {Object.values(groupedArmor[selectedClass]).flat().length === 0 && (
              <div className="py-20 text-center text-slate-500">
                No armor pieces found for your {CLASS_MAP[selectedClass]}.
              </div>
            )}
          </div>
        )}
      </main>

      {/* ITEM MODAL */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={() => setSelectedItem(null)}>
          <div 
            className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden shadow-2xl max-w-md w-full flex flex-col max-h-[90vh]"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header/Banner */}
            <div className="relative h-32 bg-slate-800 flex items-end p-4 border-b-4 shrink-0" style={{ 
              borderBottomColor: 
                selectedItem.definition.inventory?.tierType === 6 ? '#eab308' :
                selectedItem.definition.inventory?.tierType === 5 ? '#a855f7' :
                selectedItem.definition.inventory?.tierType === 4 ? '#3b82f6' : '#64748b'
             }}>
               {/* Background Watermark */}
               <div 
                 className="absolute inset-0 opacity-20 bg-cover bg-center"
                 style={{ backgroundImage: `url(${getBungieUrl(selectedItem.definition.displayProperties.icon)})`, filter: 'blur(10px)' }}
               />
               
               <div className="relative z-10 flex gap-4 items-end">
                  <div className={`w-16 h-16 rounded border-2 ${getTierColor(selectedItem.definition.inventory?.tierType)} bg-slate-950 overflow-hidden`}>
                    <img src={getBungieUrl(selectedItem.definition.displayProperties.icon)} alt="icon" className="w-full h-full object-cover" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white leading-tight">
                      {selectedItem.definition.displayProperties.name}
                    </h2>
                    <p className="text-sm font-medium text-slate-300">
                      {selectedItem.definition.itemTypeDisplayName}
                    </p>
                  </div>
               </div>
               
               <button 
                 onClick={() => setSelectedItem(null)}
                 className="absolute top-4 right-4 p-1 rounded-full bg-black/40 hover:bg-black/60 text-white transition-colors"
               >
                 <X className="w-5 h-5" />
               </button>
            </div>

            {/* Modal Body (Scrollable) */}
            <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar">
              
              {/* Flavor Text */}
              <p className="text-slate-400 italic text-sm leading-relaxed border-l-2 border-slate-700 pl-4">
                "{selectedItem.definition.displayProperties.description || 'No description available.'}"
              </p>

              {/* Pre-parse sockets to use across multiple sections */}
              {(() => {
                const parsedSockets = parseSockets(selectedItem.sockets);
                const { masterwork, archetype, statsAndTuning, slotMods, intrinsic, cosmetics, statMods, tuningMods, hasBalancedTuning } = parsedSockets;
                
                // Identify MW behavior: 3.0 (has Archetype) vs 2.0 (no Archetype)
                const isArmor3 = archetype.length > 0;
                let zeroBaseHashes = [];
                const finalTuningMods = { ...tuningMods };
                
                if (isArmor3) {
                   // In 3.0, to find the true natural zeroes, we must subtract the modifiers from the API's total
                   const naturalStats = STAT_ORDER.map(hash => {
                      const apiTotal = selectedItem.stats[hash]?.value || 0;
                      const val = apiTotal - (statMods[hash] || 0) - (tuningMods[hash] || 0);
                      return { hash, val };
                   });
                   // The 3 lowest natural values represent the zero-base stats that receive the MW bonus
                   naturalStats.sort((a, b) => a.val - b.val);
                   zeroBaseHashes = naturalStats.slice(0, 3).map(obj => obj.hash);

                   // Apply Balanced Tuning dynamically to the identified zero-base stats
                   if (hasBalancedTuning) {
                     zeroBaseHashes.forEach(hash => {
                       finalTuningMods[hash] += 1;
                     });
                   }
                }

                return (
                  <>
                    {/* Armor Stats Section */}
                    {Object.keys(selectedItem.stats).length > 0 && (
                      <div className="pt-4 border-t border-slate-800/50">
                        <div className="flex flex-col gap-1.5 bg-slate-900/50 p-3 rounded-lg border border-slate-800/50">
                          {STAT_ORDER.map(hash => {
                            const name = STAT_MAP[hash];
                            
                            // 1. Isolate the API's Final Total
                            const apiTotal = selectedItem.stats[hash]?.value || 0;

                            // 2. Extract Mod Stats
                            const statModValue = statMods[hash] || 0;
                            const tuningModValue = finalTuningMods[hash] || 0;
                            
                            // 3. Deduce Natural Stat (Base + Masterwork)
                            const naturalStat = apiTotal - statModValue - tuningModValue;

                            // 4. Split Natural Stat into Base and Masterwork
                            let mwValue = 0;
                            let baseValue = 0;

                            if (isArmor3) {
                                if (zeroBaseHashes.includes(hash)) {
                                    mwValue = naturalStat; // Because Base is 0, the entire natural stat is MW
                                    baseValue = 0;
                                } else {
                                    mwValue = 0;
                                    baseValue = naturalStat;
                                }
                            } else {
                                // Armor 2.0 Logic: +2 to all if Energy is 10
                                const energy = selectedItem.instanceData?.energy?.energyCapacity || 0;
                                mwValue = energy === 10 ? 2 : 0;
                                baseValue = Math.max(0, naturalStat - mwValue);
                            }
                            
                            // 5. Visual Bar calculations
                            const totalValue = apiTotal;
                            const penalty = Math.abs(tuningModValue < 0 ? tuningModValue : 0);
                            const bonus = statModValue + (tuningModValue > 0 ? tuningModValue : 0);

                            const isZero = totalValue === 0;
                            const isNegative = totalValue < 0;
                            const isModified = (statModValue !== 0) || (tuningModValue !== 0) || (mwValue !== 0);
                            
                            const MAX_STAT = 42; 

                            // Define visible segments
                            const activeBase = Math.max(0, baseValue - penalty);
                            const activeMw = mwValue; // For 3.0, MW happens on 0-base stats, so penalty eats MW if base=0. But Destiny normally draws it sequentially.

                            return (
                              <div key={hash} className="group relative flex items-center text-[13px] leading-none cursor-default">
                                
                                {/* Stat Tooltip (Shown on Hover) */}
                                <div className="absolute left-1/2 bottom-full mb-1 -translate-x-1/2 w-max p-2.5 bg-slate-800 border border-slate-600 rounded-md shadow-2xl opacity-0 group-hover:opacity-100 pointer-events-none z-30 text-xs transition-opacity">
                                  <div className="text-slate-400 flex justify-between gap-4"><span>Base:</span> <span className="text-white">{baseValue}</span></div>
                                  {mwValue > 0 && <div className="text-slate-400 flex justify-between gap-4"><span>Masterwork:</span> <span className="text-amber-400">+{mwValue}</span></div>}
                                  {statModValue !== 0 && <div className="text-slate-400 flex justify-between gap-4"><span>Stat Mod:</span> <span className="text-sky-400">{statModValue > 0 ? '+' : ''}{statModValue}</span></div>}
                                  {tuningModValue !== 0 && <div className="text-slate-400 flex justify-between gap-4"><span>Tuning Mod:</span> <span className={tuningModValue > 0 ? "text-sky-400" : "text-red-400"}>{tuningModValue > 0 ? '+' : ''}{tuningModValue}</span></div>}
                                  <div className="mt-1.5 pt-1.5 border-t border-slate-700 flex justify-between gap-4 font-bold">
                                    <span className="text-white">Total:</span> 
                                    <span className={isNegative ? "text-red-500" : "text-white"}>{totalValue}</span>
                                  </div>
                                </div>

                                {/* Modified Icon Indicator */}
                                <div className="w-5 flex justify-center text-slate-300">
                                  {isModified && <ChevronsUpDown className="w-3 h-3" />}
                                </div>
                                
                                <span className={`w-20 text-right pr-2 ${!isZero ? 'font-bold' : ''} ${isNegative ? 'text-red-600' : 'text-white'}`}>
                                  {name}
                                </span>
                                <span className={`w-8 text-right font-mono ${!isZero ? 'font-bold' : ''} ${isNegative ? 'text-red-600' : 'text-white'}`}>
                                  {totalValue > 0 ? `+${totalValue}` : totalValue}
                                </span>
                                
                                {/* Generic Icon Space Placeholder */}
                                <div className="w-6 flex justify-center opacity-70 ml-1">
                                   <div className="w-2 h-2 bg-slate-500 rounded-sm rotate-45"></div>
                                </div>

                                {/* Composite Segmented Bar */}
                                <div className="flex-1 bg-slate-800 h-3 flex items-center justify-start overflow-hidden ml-1 relative">
                                  
                                  {/* Draw standard positive layout if total is >= 0 */}
                                  {totalValue >= 0 && (
                                    <>
                                      {activeBase > 0 && <div className="bg-white h-full" style={{ width: `${(activeBase / MAX_STAT) * 100}%` }}></div>}
                                      {penalty > 0 && <div className="bg-red-800 h-full" style={{ width: `${(penalty / MAX_STAT) * 100}%` }}></div>}
                                      {activeMw > 0 && <div className="bg-amber-400 h-full shadow-[0_0_8px_rgba(251,191,36,0.8)] z-10" style={{ width: `${(activeMw / MAX_STAT) * 100}%` }}></div>}
                                      {bonus > 0 && <div className="bg-sky-400 h-full" style={{ width: `${(bonus / MAX_STAT) * 100}%` }}></div>}
                                    </>
                                  )}
                                  
                                  {/* If Total falls negative due to penalty eating everything */}
                                  {totalValue < 0 && (
                                     <div className="bg-red-900/80 h-full absolute left-0 top-0" style={{ width: `${(Math.abs(totalValue) / MAX_STAT) * 100}%` }}></div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                          
                          {/* Stat Total Calculation */}
                          {(() => {
                            let totalBase = 0;
                            let totalMw = 0;
                            let totalStatMod = 0;
                            let totalTuningMod = 0;

                            STAT_ORDER.forEach(hash => {
                                const apiTotal = selectedItem.stats[hash]?.value || 0;
                                const sm = statMods[hash] || 0;
                                const tm = finalTuningMods[hash] || 0;
                                const nat = apiTotal - sm - tm;
                                
                                if (isArmor3) {
                                    if (zeroBaseHashes.includes(hash)) {
                                        totalMw += nat;
                                    } else {
                                        totalBase += nat;
                                    }
                                } else {
                                    const energy = selectedItem.instanceData?.energy?.energyCapacity || 0;
                                    const mw = energy === 10 ? 2 : 0;
                                    totalMw += mw;
                                    totalBase += Math.max(0, nat - mw);
                                }
                                
                                totalStatMod += sm;
                                totalTuningMod += tm;
                            });
                            
                            const overallTotal = totalBase + totalMw + totalStatMod + totalTuningMod;
                            const allModsSum = totalStatMod + totalTuningMod;
                            
                            return (
                              <div className="flex items-center text-[13px] leading-none mt-1">
                                <div className="w-5"></div>
                                <span className="w-20 text-right pr-2 text-white font-bold">Total</span>
                                <div className="w-8 flex flex-col items-end">
                                  <div className="w-6 border-t border-white mb-1"></div>
                                  <span className="text-white font-bold font-mono">
                                    {overallTotal}
                                  </span>
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
                            );
                          })()}
                        </div>
                      </div>
                    )}

                    {/* Archetype, Exotic Trait & Set Bonus Banner */}
                    {(archetype.length > 0 || intrinsic.length > 0 || selectedSetBonus) && (
                      <div className="pt-2 space-y-2">
                        {/* Archetype */}
                        {archetype.map((def, idx) => {
                          const rawDesc = def.displayProperties.description || '';
                          // Filter out the flavor text to only show the "Primary Stat / Secondary Stat" lines
                          const statLines = rawDesc.split('\n').filter(line => line.includes('Stat:'));
                          
                          return (
                            <div key={`arch-${idx}`} className="flex items-center gap-3 py-1">
                              <div className="relative w-10 h-10 flex items-center justify-center shrink-0">
                                <img src={getBungieUrl(def.displayProperties.icon)} alt={def.displayProperties.name} className="w-full h-full object-contain" />
                              </div>
                              <div className="flex flex-col">
                                <h4 className="text-sm font-bold text-slate-200">{def.displayProperties.name}</h4>
                                {statLines.map((line, i) => (
                                  <p key={i} className="text-[11px] text-slate-400 font-medium">
                                    {line}
                                  </p>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                        
                        {/* Set Bonus Info (Edge of Fate) */}
                        {selectedSetBonus && selectedSetBonus.perks.length > 0 && (
                          <div className="flex flex-col gap-1.5 py-2">
                            <h4 className="text-sm font-bold text-indigo-400 border-b border-indigo-900/50 pb-1 mb-1">
                              {selectedSetBonus.name} Set
                            </h4>
                            {selectedSetBonus.perks.map((perk, idx) => (
                              <div key={idx} className="flex items-start gap-2">
                                <div className="text-xs font-bold text-indigo-300 whitespace-nowrap pt-0.5">
                                  {perk.count}-piece:
                                </div>
                                <div className="text-[11px] text-slate-300 font-medium leading-relaxed">
                                  <span className="font-bold text-slate-200 mr-1">{perk.name} -</span>
                                  {perk.description}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Exotic Trait / Intrinsic */}
                        {intrinsic.map((def, idx) => (
                          <div key={`intr-${idx}`} className="flex items-start gap-3 py-1">
                            <div className="relative w-10 h-10 flex items-center justify-center shrink-0 bg-slate-900 rounded border border-slate-700/50 p-1">
                              <img src={getBungieUrl(def.displayProperties.icon)} alt={def.displayProperties.name} className="w-full h-full object-contain" />
                            </div>
                            <div className="flex flex-col">
                              <h4 className="text-sm font-bold text-amber-400">{def.displayProperties.name}</h4>
                              <p className="text-[11px] text-slate-400 font-medium leading-relaxed mt-0.5">
                                {def.displayProperties.description}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Sockets / Mods Section (Structured Rows) */}
                    {(() => {
                      const hasGridMods = masterwork.length > 0 || statsAndTuning.length > 0 || slotMods.length > 0 || cosmetics.length > 0;
                      if (!hasGridMods) return null;

                      return (
                        <div className="pt-4 border-t border-slate-800/50">
                          <h4 className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-3">Sockets & Mods</h4>
                          <div className="flex flex-col gap-4 bg-slate-900/30 p-4 rounded-lg border border-slate-800/50">
                            
                            {/* Row 0: Masterwork / Upgrade */}
                            {masterwork.length > 0 && (
                              <div>
                                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Masterwork Status</span>
                                {renderModRow(masterwork)}
                              </div>
                            )}

                            {/* Row 1: Stat & Tuning Mods */}
                            {statsAndTuning.length > 0 && (
                              <div>
                                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Stat Mods</span>
                                {renderModRow(statsAndTuning)}
                              </div>
                            )}
                            
                            {/* Row 2: Slot-Specific Armor Mods */}
                            {slotMods.length > 0 && (
                              <div>
                                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Armor Mods</span>
                                {renderModRow(slotMods)}
                              </div>
                            )}

                            {/* Row 3: Cosmetics (Shaders & Ornaments) */}
                            {cosmetics.length > 0 && (
                              <div>
                                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Cosmetics</span>
                                {renderModRow(cosmetics)}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                );
              })()}
              
              {/* Technical Details Section */}
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

    </div>
  );
}