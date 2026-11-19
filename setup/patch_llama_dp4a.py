#!/usr/bin/env python3
"""llama.cpp's ggml_cuda_dp4a below sm_61: four byte-select vmad instead of the byte-wise sum."""
import sys
OLD = """    const int8_t * a8 = (const int8_t *) &a;
    const int8_t * b8 = (const int8_t *) &b;
    return c + a8[0]*b8[0] + a8[1]*b8[1] + a8[2]*b8[2] + a8[3]*b8[3];
#endif // __CUDA_ARCH__ >= GGML_CUDA_CC_DP4A || defined(GGML_USE_MUSA)
"""
NEW = """    // Maxwell and GP100: four byte-select vmad, the same result as the byte-wise sum and 2.4x its rate (Strata's strata_dp4a).
    int r = c;
    asm("vmad.s32.s32.s32 %0, %1.b0, %2.b0, %0;\\n\\t"
        "vmad.s32.s32.s32 %0, %1.b1, %2.b1, %0;\\n\\t"
        "vmad.s32.s32.s32 %0, %1.b2, %2.b2, %0;\\n\\t"
        "vmad.s32.s32.s32 %0, %1.b3, %2.b3, %0;"
        : "+r"(r) : "r"(a), "r"(b));
    return r;
#endif // __CUDA_ARCH__ >= GGML_CUDA_CC_DP4A || defined(GGML_USE_MUSA)
"""
for p in sys.argv[1:]:
    s = open(p).read()
    if NEW in s:
        print("already", p)
        continue
    assert OLD in s, p
    open(p, "w").write(s.replace(OLD, NEW, 1))
    print("patched", p)
