import { useState, useEffect } from 'react'

const CLIENT_ID = '52410'; // Your Bungie Client ID
const API_KEY = 'd7873948e4c74594845880f5aafa9b81'; // Your Bungie API Key

// Dynamically grab the local URL (e.g. https://localhost:5173/destiny-armor-crafter/)
const REDIRECT_URI = window.location.origin + window.location.pathname;

// Order of stats for rendering
const STAT_HASHES = [
  2996146975, // Mobility
  392767087,  // Resilience
  1943323491, // Recovery
  1735777505, // Discipline
  144602215,  // Intellect
  4244567218  // Strength
];

function App() {
  // State to manage what screen the user sees
  const [view, setView] = useState('login'); // 'login', 'loading', 'dashboard'
  const [loadingStatus, setLoadingStatus] = useState('Initializing...');
  
  // State to hold our Bungie data
  const [auth, setAuth] = useState({ accessToken: null, refreshToken: null });
  const [memberships, setMemberships] = useState(null);
  const [characters, setCharacters] = useState([]);
  const [armor, setArmor] = useState([]);
  const [builds, setBuilds] = useState([]);
  const [editingBuild, setEditingBuild] = useState(null);
  
  // New State for Build Editor features
  const [statDefs, setStatDefs] = useState({});
  const [exotics, setExotics] = useState([]);
  const [armorSetBonuses, setArmorSetBonuses] = useState([]);
  const [selectorModal, setSelectorModal] = useState(null); // 'exotic' | 'setBonus'
  const [generatedBuilds, setGeneratedBuilds] = useState([]);

  // This hook runs once when the app first loads
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const authCode = urlParams.get('code');

    // If we have a code, we just came back from Bungie.net
    if (authCode) {
      setView('loading');
      setLoadingStatus('Authenticating with Bungie...');

      const authenticate = async () => {
        try {
          // Hide the code from the URL for cleanliness
          window.history.replaceState({}, document.title, window.location.pathname);

          const tokenData = await getAccessToken(authCode);
          setAuth({
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token
          });

          setLoadingStatus('Downloading Destiny 2 Manifest...');
          const manifestRes = await fetch('https://www.bungie.net/Platform/Destiny2/Manifest/', {
            headers: { 'X-API-Key': API_KEY }
          });
          const manifestData = await manifestRes.json();
          const itemDefPath = manifestData.Response.jsonWorldComponentContentPaths.en.DestinyInventoryItemDefinition;
          const statDefPath = manifestData.Response.jsonWorldComponentContentPaths.en.DestinyStatDefinition;
          
          setLoadingStatus('Parsing Manifest Data...');
          const [itemDefRes, statDefRes] = await Promise.all([
            fetch(`https://www.bungie.net${itemDefPath}`),
            fetch(`https://www.bungie.net${statDefPath}`)
          ]);
          const itemDefs = await itemDefRes.json();
          const statDefsData = await statDefRes.json();

          setLoadingStatus('Extracting Exotics & Manifest Properties...');
          const uniqueExoticsMap = new Map();
          const uniqueSetBonusesMap = new Map();

          Object.values(itemDefs).forEach(def => {
            if (def.itemCategoryHashes?.includes(20)) { // Category 20 is Armor
              // Find Exotics
              if (def.inventory?.tierType === 6) { // Tier 6 is Exotic
                if (!uniqueExoticsMap.has(def.displayProperties.name)) {
                  uniqueExoticsMap.set(def.displayProperties.name, {
                    hash: def.hash,
                    name: def.displayProperties.name,
                    icon: def.displayProperties.icon,
                    description: def.displayProperties.description,
                    classType: def.classType,
                    bucketHash: def.inventory.bucketTypeHash
                  });
                }
              }

              // Find Set Bonuses dynamically via trait IDs!
              if (def.traitIds) {
                def.traitIds.forEach(traitId => {
                  if (traitId.startsWith('armor_set.')) {
                    if (!uniqueSetBonusesMap.has(traitId)) {
                      // Make it pretty: 'armor_set.iron_banner' -> 'Iron Banner'
                      const cleanName = traitId.split('.').pop().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                      uniqueSetBonusesMap.set(traitId, { id: traitId, name: cleanName + " Set", description: "Equip matching armor pieces to activate set bonuses." });
                    }
                  }
                });
              }
            }
          });
          
          if (uniqueSetBonusesMap.size === 0) {
            const knownSets = [
              { id: 'armor_set.iron_banner', name: 'Iron Banner Set', description: 'Enhances Iron Banner rewards and reputation.' },
              { id: 'armor_set.trials', name: 'Trials of Osiris Set', description: 'Enhances Trials rewards.' },
              { id: 'armor_set.raid.root_of_nightmares', name: 'Root of Nightmares Set', description: 'Provides bonuses in the Root of Nightmares raid.' },
              { id: 'armor_set.raid.crotas_end', name: 'Crota\'s End Set', description: 'Provides bonuses in the Crota\'s End raid.' },
              { id: 'armor_set.seasonal', name: 'Seasonal Set', description: 'Provides seasonal vendor reputation bonuses.' }
            ];
            knownSets.forEach(sb => uniqueSetBonusesMap.set(sb.id, sb));
          }
          setExotics(Array.from(uniqueExoticsMap.values()));
          setArmorSetBonuses(Array.from(uniqueSetBonusesMap.values()));

          const extractedStats = {};
          STAT_HASHES.forEach(hash => extractedStats[hash] = statDefsData[hash]);
          setStatDefs(extractedStats);

          setLoadingStatus('Fetching Memberships...');
          const membershipData = await getMemberships(tokenData.access_token);
          setMemberships(membershipData.Response);

          const primaryMembership = membershipData.Response.destinyMemberships[0];
          if (primaryMembership) {
            setLoadingStatus('Fetching Inventory & Stats...');
            const profileData = await getProfile(tokenData.access_token, primaryMembership.membershipType, primaryMembership.membershipId);
            
            setCharacters(Object.values(profileData.Response.characters.data));

            // Combine Vault, Character, and Equipped Items
            const vaultItems = profileData.Response.profileInventory?.data?.items || [];
            const charItems = Object.values(profileData.Response.characterInventories?.data || {}).flatMap(charInv => charInv.items);
            const equippedItems = Object.values(profileData.Response.characterEquipment?.data || {}).flatMap(charEquip => charEquip.items);
            
            const allItems = [...vaultItems, ...charItems, ...equippedItems];

            // Filter for Armor Bucket Hashes (Helmet, Arms, Chest, Legs, Class Item)
            const armorBuckets = [3448274439, 3551918436, 14239492, 20886954, 1585787867];
            
            // Filter using the Manifest definitions, then enrich the data!
            const enrichedArmor = allItems.filter(item => {
              const def = itemDefs[item.itemHash];
              return def && armorBuckets.includes(def.inventory?.bucketTypeHash);
            }).map(item => ({
              ...item,
              definition: itemDefs[item.itemHash],
              instanceData: profileData.Response.itemComponents?.instances?.data?.[item.itemInstanceId],
              statsData: profileData.Response.itemComponents?.stats?.data?.[item.itemInstanceId]
            }));
            
            setArmor(enrichedArmor);
          }

          // We are in! Let's show the dashboard
          setView('dashboard');
        } catch (err) {
          console.error("Auth error:", err);
          alert("Authentication failed. Check your App config in the Bungie Developer Portal.");
          setView('login');
        }
      };

      authenticate();
    }
  }, []); // The empty array ensures this only runs ONCE on load

  // Auto update builds when editing
  useEffect(() => {
    if (view === 'editor' && editingBuild && armor.length > 0) {
      const timer = setTimeout(() => {
        calculateBuilds();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [editingBuild, armor, view]);

  // API Calls
  const authorize = () => {
    window.location.href = `https://www.bungie.net/en/OAuth/Authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  };

  const getAccessToken = async (code) => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI
    });
    const res = await fetch('https://www.bungie.net/Platform/App/OAuth/Token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    });
    if (!res.ok) throw new Error("Failed to exchange token.");
    return res.json();
  };

  const getMemberships = async (accessToken) => {
    const res = await fetch('https://www.bungie.net/Platform/User/GetMembershipsForCurrentUser/', {
      headers: {
        'X-API-Key': API_KEY,
        'Authorization': `Bearer ${accessToken}`
      }
    });
    if (!res.ok) throw new Error("Failed to get memberships.");
    return res.json();
  };

  const getProfile = async (accessToken, membershipType, membershipId) => {
    // 200: Characters, 102: Vault, 201: Char Inventory, 205: Char Equipment, 300: Item Instances, 304: Item Stats
    const components = "200,102,201,205,300,304";
    const res = await fetch(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/?components=${components}`, {
      headers: {
        'X-API-Key': API_KEY,
        'Authorization': `Bearer ${accessToken}`
      }
    });
    if (!res.ok) throw new Error("Failed to get profile and inventory.");
    return res.json();
  };

  const getClassDef = (classType) => {
    switch(classType) {
      case 0: return "Titan";
      case 1: return "Hunter";
      case 2: return "Warlock";
      default: return "Unknown";
    }
  };

  // The Build Solver!
  const calculateBuilds = () => {
    if (!editingBuild) return;
    
    const getBucketName = (hash) => {
      if(hash === 3448274439) return "Helmet";
      if(hash === 3551918436) return "Gauntlets";
      if(hash === 14239492) return "Chest Armor";
      if(hash === 20886954) return "Leg Armor";
      return "Armor";
    };

    // Generate hypothetically perfect max-stat (68) distributions for simulation
    const generateTheoreticalArmor = (bucketHash) => {
      const splits = [
        [30, 2, 2], [2, 30, 2], [2, 2, 30],
        [16, 16, 2], [16, 2, 16], [2, 16, 16]
      ];
      const pieces = [];
      let i = 0;
      splits.forEach(top => {
        splits.forEach(bot => {
          pieces.push({
            isTheoretical: true,
            itemInstanceId: `theo_${bucketHash}_${i++}`,
            definition: {
              displayProperties: {
                name: `Theoretical ${getBucketName(bucketHash)}`,
                icon: '/img/misc/missing_icon_d2.png'
              },
              inventory: { bucketTypeHash: bucketHash },
              classType: editingBuild.classType
            },
            statsData: {
              stats: {
                2996146975: { value: top[0] },
                392767087:  { value: top[1] },
                1943323491: { value: top[2] },
                1735777505: { value: bot[0] },
                144602215:  { value: bot[1] },
                4244567218: { value: bot[2] }
              }
            }
          });
        });
      });
      return pieces;
    };

    let filteredHelmets = generateTheoreticalArmor(3448274439);
    let filteredArms = generateTheoreticalArmor(3551918436);
    let filteredChests = generateTheoreticalArmor(14239492);
    let filteredLegs = generateTheoreticalArmor(20886954);

    const targets = editingBuild.targetStats;
    const mods = editingBuild.modsAndFragments;

    if (editingBuild.exotic) {
      const exHash = editingBuild.exotic.hash;
      const exBucket = editingBuild.exotic.bucketHash;
      const exoticPieces = generateTheoreticalArmor(exBucket).map(p => ({
        ...p,
        definition: {
          ...p.definition,
          displayProperties: {
            name: editingBuild.exotic.name + " (Simulated)",
            icon: editingBuild.exotic.icon
          }
        }
      }));
      
      if (exBucket === 3448274439) filteredHelmets = exoticPieces;
      if (exBucket === 3551918436) filteredArms = exoticPieces;
      if (exBucket === 14239492) filteredChests = exoticPieces;
      if (exBucket === 20886954) filteredLegs = exoticPieces;
    }

    const results = [];
    let iterations = 0;
    
    for (let h of filteredHelmets) {
      for (let a of filteredArms) {
        for (let c of filteredChests) {
          for (let l of filteredLegs) {
            const buildStats = { 2996146975: 0, 392767087: 0, 1943323491: 0, 1735777505: 0, 144602215: 0, 4244567218: 0 };
            
            STAT_HASHES.forEach(hash => {
              buildStats[hash] += h.statsData.stats[hash].value;
              buildStats[hash] += a.statsData.stats[hash].value;
              buildStats[hash] += c.statsData.stats[hash].value;
              buildStats[hash] += l.statsData.stats[hash].value;
              
              // Masterwork (+2 per piece, 5 pieces total = +10)
              buildStats[hash] += 10;
              
              // Mods & Fragments
              buildStats[hash] += (mods[hash] || 0);
            });

            let deficit = 0;
            let overage = 0;
            let meetsMinimums = true;

            STAT_HASHES.forEach(hash => {
              const target = targets[hash];
              const val = buildStats[hash];
              if (val < target.min) {
                deficit += (target.min - val) * target.priority; // higher priority means worse deficit
                meetsMinimums = false;
              }
              if (val > target.max) {
                overage += (val - target.max);
              }
            });

            if (meetsMinimums || deficit <= 30) { 
              results.push({
                id: Math.random(),
                pieces: [h, a, c, l],
                stats: buildStats,
                deficit,
                overage
              });
            }
          }
        }
      }
    }
    
    // De-dupe identical stat results for cleaner UI
    const uniqueResults = [];
    const seenStats = new Set();
    
    const sortedResults = results.sort((a,b) => a.deficit - b.deficit || a.overage - b.overage);
    
    for (let res of sortedResults) {
      const sig = STAT_HASHES.map(hash => res.stats[hash]).join(',');
      if (!seenStats.has(sig)) {
        seenStats.add(sig);
        uniqueResults.push(res);
      }
      if (uniqueResults.length >= 50) break;
    }

    setGeneratedBuilds(uniqueResults);
  };

  return (
    <div className="min-h-screen flex flex-col items-center bg-[#0f172a] text-white">
      
      {/* Header */}
      <header className="w-full border-b border-gray-800 bg-gray-900/50 p-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-900/30 rounded-lg border border-purple-500/30">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path>
              </svg>
            </div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight">Destiny 2 Armor Buildcrafter</h1>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-grow p-4 md:p-8 w-full max-w-7xl mx-auto">
        
        {/* View: Login */}
        {view === 'login' && (
          <div className="max-w-2xl mx-auto mt-10 text-center">
            <div className="rounded-xl p-12 flex flex-col items-center justify-center border border-gray-800 bg-gray-900/50 shadow-2xl">
              <h2 className="text-3xl font-bold text-gray-100 mb-4">Welcome to the Armor Buildcrafter</h2>
              <p className="text-gray-400 max-w-xl mx-auto mb-8">
                Connect your Bungie.net account to analyze your inventory, create powerful builds, and identify the exact armor pieces you need to chase.
              </p>
              <button onClick={authorize} className="bg-purple-600 hover:bg-purple-500 text-white px-10 py-4 rounded-lg font-bold transition shadow-lg border border-purple-500/50 text-lg flex items-center gap-3 cursor-pointer">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                Login with Bungie.net
              </button>
            </div>
          </div>
        )}

        {/* View: Loading */}
        {view === 'loading' && (
          <div className="max-w-2xl mx-auto mt-10 text-center">
            <div className="rounded-xl p-12 flex flex-col items-center justify-center border border-gray-800 bg-gray-900/50">
              <div className="w-10 h-10 border-4 border-gray-300 border-t-purple-500 rounded-full animate-spin mb-6"></div>
              <h2 className="text-2xl font-bold text-gray-200 animate-pulse">{loadingStatus}</h2>
            </div>
          </div>
        )}

        {/* View: Dashboard */}
        {view === 'dashboard' && (
          <div className="animate-fade-in">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-3xl font-bold text-white">My Characters</h2>
              <button onClick={() => {
                setGeneratedBuilds([]);
                setEditingBuild({
                  id: Date.now(),
                  name: 'New Build',
                  classType: 0, // 0: Titan, 1: Hunter, 2: Warlock
                  subclass: 'Void',
                  exotic: null,
                  setBonus: null,
                  targetStats: { 
                    2996146975: { min: 0, max: 200, priority: 6 }, // Mob
                    392767087: { min: 0, max: 200, priority: 1 },  // Res
                    1943323491: { min: 0, max: 200, priority: 2 }, // Rec
                    1735777505: { min: 0, max: 200, priority: 3 }, // Dis
                    144602215: { min: 0, max: 200, priority: 5 },  // Int
                    4244567218: { min: 0, max: 200, priority: 4 }  // Str
                  },
                  modsAndFragments: { 2996146975: 0, 392767087: 0, 1943323491: 0, 1735777505: 0, 144602215: 0, 4244567218: 0 }
                });
                setView('editor');
              }} className="bg-green-600 hover:bg-green-500 text-white px-6 py-2.5 rounded-lg font-bold transition shadow-lg border border-green-500/50 flex items-center gap-2 cursor-pointer">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                New Build
              </button>
            </div>

            {/* Character Banners */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              {characters.map(char => (
                <div key={char.characterId} className="relative rounded-xl overflow-hidden shadow-lg border border-gray-700 bg-gray-800 min-h-[120px]">
                  <div 
                    className="absolute inset-0 bg-cover bg-center z-0 opacity-60"
                    style={{ backgroundImage: `url(https://www.bungie.net${char.emblemBackgroundPath})` }}
                  ></div>
                  <div className="relative z-10 p-6 flex flex-col items-start bg-gradient-to-r from-gray-900/90 via-gray-900/60 to-transparent h-full">
                    <span className="text-2xl font-bold text-white drop-shadow-md">{getClassDef(char.classType)}</span>
                    <span className="text-yellow-400 font-bold text-xl drop-shadow-md flex items-center gap-1 mt-1">
                      <span className="text-sm">✧</span>{char.light}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Inventory Status Widget */}
            <div className="grid grid-cols-1 gap-6">
              <div className="p-8 rounded-xl text-center flex flex-col items-center justify-center border border-gray-700 bg-gray-800/50 shadow-lg relative overflow-hidden">
                <div className="absolute -top-10 -right-10 w-40 h-40 bg-purple-600/10 rounded-full blur-3xl"></div>
                <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-blue-600/10 rounded-full blur-3xl"></div>
                
                <h3 className="text-2xl font-bold text-gray-200 mb-2 relative z-10">Inventory Synced</h3>
                <p className="text-gray-400 text-lg relative z-10">
                  We found <span className="text-purple-400 font-bold mx-1">{armor.length}</span> pieces of armor across your Vault and Characters.
                </p>
                
                {/* Prove the manifest is working by showing the first 4 items! */}
                <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 relative z-10 w-full">
                  {armor.slice(0, 4).map((item, idx) => (
                    <div key={idx} className="flex items-center gap-3 bg-gray-900/80 p-3 rounded-lg border border-gray-700">
                      <img src={`https://www.bungie.net${item.definition.displayProperties.icon}`} className="w-10 h-10 rounded" alt="icon"/>
                      <div className="text-left overflow-hidden">
                        <p className="text-sm font-bold text-gray-200 truncate">{item.definition.displayProperties.name}</p>
                        <p className="text-xs text-yellow-400">Power: {item.instanceData?.primaryStat?.value || 'N/A'}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Builds Section */}
            <div className="mt-12 mb-12">
              <h2 className="text-3xl font-bold text-white mb-6">My Builds</h2>
              {builds.length === 0 ? (
                <div className="p-6 rounded-xl text-center flex flex-col items-center justify-center h-48 border-2 border-dashed border-gray-700 bg-gray-900/50">
                  <p className="text-gray-400">You have no builds yet.</p>
                  <p className="text-gray-500 text-sm mt-2">Click "New Build" to start crafting!</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {builds.map(build => (
                    <div key={build.id} className="p-6 rounded-xl border border-gray-700 bg-gray-800 shadow-lg flex flex-col">
                      <h3 className="text-xl font-bold text-purple-400">{build.name}</h3>
                      <div className="mt-4 grid grid-cols-2 gap-2 text-sm text-gray-300 mb-6">
                        {STAT_HASHES.map(hash => {
                          const target = build.targetStats[hash];
                          return (
                            <div key={hash} className="flex justify-between items-center bg-gray-900 px-2 py-1 rounded border border-gray-700">
                              <img src={`https://www.bungie.net${statDefs[hash]?.displayProperties?.icon}`} alt="" className="w-4 h-4" />
                              <span className="font-mono font-bold text-white">{target.min}-{target.max}</span>
                            </div>
                          );
                        })}
                      </div>
                      <button onClick={() => { setEditingBuild(build); setGeneratedBuilds([]); setView('editor'); }} className="mt-auto bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded text-sm font-bold transition cursor-pointer">Edit Build</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* View: Build Editor */}
        {view === 'editor' && editingBuild && (
          <div className="animate-fade-in flex flex-col h-[85vh]">
            {(() => {
              const sortedHashes = [...STAT_HASHES].sort((a,b) => editingBuild.targetStats[a].priority - editingBuild.targetStats[b].priority);
              return (
                <>
            {/* Build Editor Header */}
            <div className="flex justify-between items-center pb-4 border-b border-gray-800 mb-4 shrink-0">
              <input 
                type="text" 
                value={editingBuild.name}
                onChange={(e) => setEditingBuild({...editingBuild, name: e.target.value})}
                className="bg-transparent border-b-2 border-transparent hover:border-gray-700 focus:border-purple-500 text-3xl font-bold text-white focus:outline-none transition px-2 py-1 max-w-sm"
              />
              <div className="flex items-center gap-4">
                  <span className="text-sm text-gray-500 font-mono">Found {generatedBuilds.length} builds</span>
                  <button onClick={() => { setView('dashboard'); setGeneratedBuilds([]); }} className="text-gray-400 hover:text-white transition cursor-pointer px-4 py-2">Cancel</button>
                  <button onClick={() => {
                    setBuilds(prev => {
                      const idx = prev.findIndex(b => b.id === editingBuild.id);
                      if (idx >= 0) { const updated = [...prev]; updated[idx] = editingBuild; return updated; }
                      return [...prev, editingBuild];
                    });
                    setView('dashboard');
                    setGeneratedBuilds([]);
                  }} className="bg-purple-600 hover:bg-purple-500 text-white font-bold px-6 py-2 rounded transition shadow-[0_0_10px_rgba(168,85,247,0.4)] border border-purple-500 cursor-pointer">
                    Save Build
                  </button>
              </div>
            </div>
            
            <div className="flex flex-col lg:flex-row gap-6 h-full min-h-0">
              
              {/* Left Sidebar: DIM-style Filters */}
              <div className="w-full lg:w-1/3 xl:w-1/4 flex flex-col gap-6 overflow-y-auto pr-2 custom-scrollbar">
                
                <div className="bg-gray-800 border border-gray-700 rounded p-4 shadow-lg">
                  <h3 className="text-gray-300 font-bold uppercase tracking-wider text-xs mb-3">Loadout Identity</h3>
                  <div className="flex flex-col gap-3">
                    <select 
                      value={editingBuild.classType}
                      onChange={(e) => setEditingBuild({...editingBuild, classType: parseInt(e.target.value), exotic: null})}
                      className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white focus:outline-none focus:border-purple-500 transition text-sm"
                    >
                      <option value={0}>Titan</option>
                      <option value={1}>Hunter</option>
                      <option value={2}>Warlock</option>
                    </select>
                    <select 
                      value={editingBuild.subclass || 'Void'}
                      onChange={(e) => setEditingBuild({...editingBuild, subclass: e.target.value})}
                      className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white focus:outline-none focus:border-purple-500 transition text-sm"
                    >
                      <option value="Void">Void</option><option value="Solar">Solar</option><option value="Arc">Arc</option>
                      <option value="Stasis">Stasis</option><option value="Strand">Strand</option><option value="Prismatic">Prismatic</option>
                    </select>
                    <button 
                      onClick={() => setSelectorModal('exotic')}
                      className="w-full flex items-center justify-between bg-gray-900 border border-gray-700 rounded p-2 text-white hover:border-yellow-500 transition text-left text-sm cursor-pointer"
                    >
                      {editingBuild.exotic ? (
                        <div className="flex items-center gap-2">
                          <img src={`https://www.bungie.net${editingBuild.exotic.icon}`} className="w-5 h-5 rounded" alt=""/>
                          <span className="font-bold text-yellow-400 truncate">{editingBuild.exotic.name}</span>
                        </div>
                      ) : (
                        <span className="text-gray-500 italic">No Exotic Selected</span>
                      )}
                    </button>
                    <button 
                      onClick={() => setSelectorModal('setBonus')}
                      className="w-full flex items-center justify-between bg-gray-900 border border-gray-700 rounded p-2 text-white hover:border-blue-500 transition text-left text-sm cursor-pointer"
                    >
                      {editingBuild.setBonus ? (
                        <span className="font-bold text-blue-400 truncate">{editingBuild.setBonus.name}</span>
                      ) : (
                        <span className="text-gray-500 italic">No Set Bonus Required</span>
                      )}
                    </button>
                  </div>
                </div>

                <div className="bg-gray-800 border border-gray-700 rounded p-4 shadow-lg">
                    <h3 className="text-gray-300 font-bold uppercase tracking-wider text-xs mb-3">Stat Tiers</h3>
                    <div className="flex flex-col gap-3">
                      {sortedHashes.map((hash) => {
                        const target = editingBuild.targetStats[hash];
                        const def = statDefs[hash];
                        if(!def) return null;
                        
                        return (
                          <div 
                            key={hash} 
                            draggable 
                            onDragStart={(e) => e.dataTransfer.setData('hash', hash.toString())}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const srcHash = parseInt(e.dataTransfer.getData('hash'));
                              if(srcHash && srcHash !== hash) {
                                const arr = [...sortedHashes];
                                const srcIdx = arr.indexOf(srcHash);
                                const tgtIdx = arr.indexOf(hash);
                                arr.splice(srcIdx, 1);
                                arr.splice(tgtIdx, 0, srcHash);
                                
                                const newTargets = { ...editingBuild.targetStats };
                                arr.forEach((h, idx) => {
                                  newTargets[h] = { ...newTargets[h], priority: idx + 1 };
                                });
                                
                                setEditingBuild(prev => ({ ...prev, targetStats: newTargets }));
                              }
                            }}
                            className="flex flex-col bg-gray-900 p-2 rounded border border-gray-700 cursor-move hover:border-gray-500 transition shadow-sm"
                          >
                            <div className="flex justify-between items-center mb-2">
                              <div className="flex items-center gap-2">
                                <div className="text-gray-500 cursor-move" title="Drag to reorder priority">☰</div>
                                <img src={`https://www.bungie.net${def.displayProperties.icon}`} className="w-5 h-5" alt="stat icon"/>
                                <span className="font-bold text-gray-300 text-sm">{def.displayProperties.name}</span>
                              </div>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] text-gray-500">Min:</span>
                                <input 
                                  type="number" min="0" max="200" value={target.min}
                                  onChange={(e) => setEditingBuild({ ...editingBuild, targetStats: { ...editingBuild.targetStats, [hash]: { ...target, min: parseInt(e.target.value) || 0 } } })}
                                  className="w-12 bg-gray-800 text-white p-0.5 text-xs text-center rounded border border-gray-600 focus:border-purple-500 outline-none"
                                />
                              </div>
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] text-gray-500">Max:</span>
                                <input 
                                  type="number" min="0" max="200" value={target.max}
                                  onChange={(e) => setEditingBuild({ ...editingBuild, targetStats: { ...editingBuild.targetStats, [hash]: { ...target, max: parseInt(e.target.value) || 0 } } })}
                                  className="w-12 bg-gray-800 text-white p-0.5 text-xs text-center rounded border border-gray-600 focus:border-purple-500 outline-none"
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

              {/* Generated Builds UI */}
              <div className="flex-1 overflow-y-auto bg-gray-900 border border-gray-700 rounded shadow-inner p-2 custom-scrollbar relative min-h-[50vh]">
                {generatedBuilds.length === 0 ? (
                  <div className="absolute inset-0 flex items-center justify-center text-center p-6 text-gray-500">
                    No builds found matching these requirements. Try lowering the minimum stats.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {generatedBuilds.map(build => (
                      <div key={build.id} className="bg-gray-800 border border-gray-700 p-3 rounded flex flex-col xl:flex-row gap-4 xl:items-center hover:border-gray-500 transition">
                        <div className="flex gap-2 shrink-0">
                          {build.pieces.map((p, i) => (
                            <img key={i} src={`https://www.bungie.net${p.definition.displayProperties.icon}`} className="w-10 h-10 rounded border border-gray-600" alt="armor" title={p.definition.displayProperties.name} />
                          ))}
                        </div>
                        <div className="flex-grow grid grid-cols-6 gap-x-2 gap-y-1 w-full xl:ml-auto xl:max-w-xl">
                           {STAT_HASHES.map((hash) => {
                             const val = build.stats[hash];
                             const target = editingBuild.targetStats[hash];
                             const isMet = val >= target.min && val <= target.max;
                             
                             return (
                               <div key={hash} className="flex flex-col">
                                 <div className="flex justify-between items-center px-1">
                                   <img src={`https://www.bungie.net${statDefs[hash]?.displayProperties?.icon}`} alt="" className="w-3 h-3 opacity-50" />
                                   <span className={`text-xs font-mono font-bold ${isMet ? 'text-gray-200' : 'text-red-400'}`}>{val}</span>
                                 </div>
                                 <div className="h-1.5 w-full bg-gray-900 rounded-full overflow-hidden mt-0.5 border border-gray-700">
                                   <div className={`h-full ${isMet ? 'bg-green-500' : 'bg-red-500'} ${val > target.max ? 'bg-yellow-500' : ''}`} style={{ width: `${Math.min(100, (val / 200) * 100)}%`}}></div>
                                 </div>
                               </div>
                             );
                           })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
                </>
              );
            })()}
          </div>
        )}

      </main>

      {/* DIM Style Selector Modal */}
      {selectorModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-4 border-b border-gray-800 flex justify-between items-center bg-gray-800/50">
              <h3 className="text-xl font-bold text-white">
                {selectorModal === 'exotic' ? 'Select Exotic Armor' : 'Select Set Bonus'}
              </h3>
              <button onClick={() => setSelectorModal(null)} className="text-gray-400 hover:text-white cursor-pointer transition">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            </div>
            
            <div className="p-4 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-4">
              {selectorModal === 'exotic' && exotics.filter(e => e.classType === editingBuild.classType).map(ex => (
                <div 
                  key={ex.hash} 
                  onClick={() => { setEditingBuild({...editingBuild, exotic: ex}); setSelectorModal(null); }}
                  className="flex gap-4 p-3 rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 hover:border-yellow-500 cursor-pointer transition group"
                >
                  <img src={`https://www.bungie.net${ex.icon}`} className="w-12 h-12 rounded border border-gray-600 group-hover:border-yellow-500" alt=""/>
                  <div>
                    <h4 className="font-bold text-yellow-400 text-sm">{ex.name}</h4>
                    <p className="text-xs text-gray-400 line-clamp-2 mt-1">{ex.description}</p>
                  </div>
                </div>
              ))}

              {selectorModal === 'setBonus' && armorSetBonuses.map(set => (
                <div 
                  key={set.id} 
                  onClick={() => { setEditingBuild({...editingBuild, setBonus: set}); setSelectorModal(null); }}
                  className="flex gap-4 p-3 rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 hover:border-blue-500 cursor-pointer transition group"
                >
                  <div className="w-12 h-12 min-w-[3rem] bg-blue-900/30 rounded flex items-center justify-center border border-blue-500/30 group-hover:border-blue-500">
                    <span className="text-blue-400 font-bold text-xs">SET</span>
                  </div>
                  <div>
                    <h4 className="font-bold text-blue-400 text-sm">{set.name}</h4>
                    <p className="text-xs text-gray-400 mt-1">{set.description}</p>
                  </div>
                </div>
              ))}
            </div>
            
            <div className="p-4 border-t border-gray-800 bg-gray-800/50">
               <button onClick={() => { 
                 setEditingBuild({...editingBuild, [selectorModal === 'exotic' ? 'exotic' : 'setBonus']: null}); 
                 setSelectorModal(null); 
               }} className="w-full py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-bold text-white transition cursor-pointer">
                 Clear Selection
               </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="w-full bg-gray-900/50 border-t border-gray-800 p-6 text-center text-gray-600 text-sm mt-auto">
        <p className="mb-2">Destiny 2 Tool Suite &bull; Created by <span className="text-gray-400">MrCharles</span></p>
        <p className="text-xs">Not affiliated with Bungie. Destiny 2 is a registered trademark of Bungie, Inc.</p>
      </footer>

    </div>
  )
}

export default App
