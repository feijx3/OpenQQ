cmake_minimum_required(VERSION 3.20)
project(openqq_native LANGUAGES CXX)

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "OpenQQ native bootstrap requires a 64-bit target")
endif()
if(NOT WIN32 AND NOT (CMAKE_SYSTEM_NAME STREQUAL "Linux"))
  message(FATAL_ERROR "OpenQQ native bootstrap supports Windows x64 and Linux x64/arm64")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 原生指针探针（napi_unwrap + VirtualQuery + 任意地址 8 字节读 + napi_create_function）。
# 默认【关闭】：这段代码同时具备内存扫描、读他人内存、注入挂函数三项高危行为特征，
# 会被杀毒软件/安全中心按通用可疑判定拦截，与是否恶意无关。
# 发布版只保留 loadSsoBridge() 里那一行 LoadLibraryW，不扫内存、不读陌生地址。
# 需要做探针实验时：cmake -DOPENQQ_ENABLE_PROBE=ON，产物只用于调试，不部署到 dist。
option(OPENQQ_ENABLE_PROBE "Compile the native pointer probe (debug only; triggers AV heuristics)" OFF)

# 调试变体产物：文件名带 -debug 后缀，与发布版并存、绝不覆盖。
#
# 用途只有一个——在真实 QQ 进程里做一次性逆向：定位发包入口、验证结构体偏移。
# 得到的结论固化成配置表（QQ 版本 → 特征/偏移），发布版只读表、不做扫描。
#
#   cmake -DOPENQQ_DEBUG_VARIANT=ON     → 产出 bin/openqq-bootstrap-debug.dll
#   cmake                               → 产出 bin/openqq-bootstrap.dll（发布版）
#
# ⚠️ -debug 产物永远不进 dist / npm / Release。scripts/build-native.mjs 的护栏
# 按文件名区分：发布版含探针符号即构建失败，-debug 版不限。
option(OPENQQ_DEBUG_VARIANT "Build openqq-bootstrap-debug.dll (probe + scanning; never shipped)" OFF)

if(WIN32)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  if(MINGW)
    add_link_options(-static)
  endif()
  add_executable(openqq-launch launch.cpp)
  add_library(openqq-bootstrap SHARED bootstrap.cpp)
  # 这里曾经还有一个 openqq-sso-local 组件：它自建命名管道、把会话指针递进去再调 QQ 的发包原语。
  # 那条路走到「只发不收」就断了（见 bootstrap.cpp 里 0x765d70 的六次实测记录），
  # 现在发包改成「让 QQ 自己调、我们只接管 body」的补丁，不再需要任何独立组件，故删除。
  if(OPENQQ_ENABLE_PROBE)
    target_compile_definitions(openqq-bootstrap PRIVATE OPENQQ_ENABLE_PROBE=1)
  endif()
else()
  find_package(Threads REQUIRED)
  add_executable(openqq-launch launch_linux.cpp)
  target_link_libraries(openqq-launch PRIVATE Threads::Threads)
  add_library(openqq-bootstrap SHARED bootstrap_linux.cpp)
  target_compile_options(openqq-bootstrap PRIVATE -fvisibility=hidden)
  target_link_libraries(openqq-bootstrap PRIVATE ${CMAKE_DL_LIBS} Threads::Threads)
endif()

set_target_properties(openqq-bootstrap PROPERTIES PREFIX "")

# 调试变体：改输出名 + 强制打开探针，不污染发布版的位置与名字。
if(OPENQQ_DEBUG_VARIANT)
  set_target_properties(openqq-bootstrap PROPERTIES OUTPUT_NAME "openqq-bootstrap-debug")
  if(WIN32)
    target_compile_definitions(openqq-bootstrap PRIVATE OPENQQ_ENABLE_PROBE=1 OPENQQ_DEBUG_VARIANT=1)
  endif()
endif()

foreach(target openqq-launch openqq-bootstrap)
  set_target_properties(${target} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    LIBRARY_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/bin")
endforeach()

include(CTest)
if(BUILD_TESTING AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../test/native-fixture.cpp")
  add_library(QQNT SHARED ../test/native-fixture.cpp)
  set_target_properties(QQNT PROPERTIES PREFIX "")
  add_executable(openqq-fixture ../test/native-fixture.cpp)
  target_compile_definitions(openqq-fixture PRIVATE FIXTURE_HOST)
  if(NOT WIN32)
    target_link_libraries(QQNT PRIVATE ${CMAKE_DL_LIBS} Threads::Threads)
    target_link_libraries(openqq-fixture PRIVATE ${CMAKE_DL_LIBS} Threads::Threads)
    add_executable(openqq-fixture-exe ../test/native-fixture.cpp)
    target_compile_definitions(openqq-fixture-exe PRIVATE FIXTURE_MAIN_EXE)
    set_target_properties(openqq-fixture-exe PROPERTIES ENABLE_EXPORTS ON)
    target_link_libraries(openqq-fixture-exe PRIVATE ${CMAKE_DL_LIBS} Threads::Threads)
    add_library(fixture-wrapper SHARED ../test/native-fixture.cpp)
    target_compile_definitions(fixture-wrapper PRIVATE FIXTURE_ADDON)
    set_target_properties(fixture-wrapper PROPERTIES PREFIX "" SUFFIX ".node")
  endif()
  foreach(target QQNT openqq-fixture)
    if(MSVC)
      target_compile_options(${target} PRIVATE /Od)
    else()
      target_compile_options(${target} PRIVATE -O0)
    endif()
  endforeach()
  if(NOT WIN32)
    target_compile_options(openqq-fixture-exe PRIVATE -O0)
    target_compile_options(fixture-wrapper PRIVATE -O0)
  endif()
endif()

# 字符串布局 / 指针链的离线自检。
# 存在的原因：2026-11-21 有 21 次崩溃是「用错了 std::string 构造 + 用错了 vtable 解引用」，
# 这两类错误都能在本地判定 —— 只要把「QQ 读回字符串的规则」当成规格写进断言。
# 这个可执行文件不加载 wrapper.node、不碰 QQ，`ctest` 里跑，任何回归都会当场红。
if(BUILD_TESTING AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../test/string-layout-selftest.cpp")
  add_executable(openqq-string-layout ../test/string-layout-selftest.cpp)
  add_test(NAME string-layout COMMAND openqq-string-layout)
endif()

# rel32 跳板的离线自检：wrapper.node 与我们 dll 可能相隔几十 GB，
# 需要一块「离得够近」的空地写 `mov rax,imm64; jmp rax`。
# 这段逻辑不能靠实机试 —— 试错的代价是一次 QQ 崩溃 + 一分钟重启。
# 跳板自检验的是「wrapper.node 与我们的 DLL 相距约 29.6GB 时 rel32 还能不能跳」——
# 那是 Windows 版的地址布局，而自研补丁本身也只实现在 Windows 引导器里，
# 所以这个 target 只在 WIN32 下构建（Linux 引导器没有这条补丁，见 build-native.mjs 的说明）。
if(BUILD_TESTING AND WIN32 AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../test/trampoline-selftest.cpp")
  add_executable(openqq-trampoline ../test/trampoline-selftest.cpp)
  add_test(NAME trampoline COMMAND openqq-trampoline)
endif()
