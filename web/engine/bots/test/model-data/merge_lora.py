# Merges the 2004 LoRA into Qwen3.5-0.8B's own checkpoint (the realism work, phase 7, Track L), for llama.cpp's
# converter.
#
# mlx-lm's `fuse` would save the model in mlx-lm's layout (its sanitize adds 1 to Qwen3.5's RMSNorm weights and moves
# the conv1d axes), which llama.cpp's converter would then read as Hugging Face's and transform a second time. So the
# merge is done here on the original safetensors instead: each adapted linear layer's weight W [out, in] becomes
#   W + scale * (lora_a @ lora_b)^T        (mlx-lm's LoRALinear: y = x W^T + scale * (x lora_a) lora_b)
# in float32, under its Hugging Face name ("language_model.model.layers.N.x" in mlx-lm is
# "model.language_model.layers.N.x.weight"); every other tensor (the vision tower, the MTP head, the norms) is kept as
# it was. The output folder is the base's (config, tokenizer, chat template) with model.safetensors replaced.
#
#   $LM_CACHE/venv/bin/python -I web/engine/bots/test/model-data/merge_lora.py <base dir> <adapters.safetensors> \
#       <adapter_config.json> <out dir>
import json
import shutil
import sys
from pathlib import Path

import mlx.core as mx


def main() -> int:
    if len(sys.argv) != 5:
        print('usage: merge_lora.py <base dir> <adapters.safetensors> <adapter_config.json> <out dir>', file=sys.stderr)
        return 2
    base, adapters_file, config_file, out = (Path(a) for a in sys.argv[1:])
    config = json.loads(config_file.read_text())
    if config.get('fine_tune_type', 'lora') != 'lora':
        print(f"merge_lora: {config.get('fine_tune_type')} adapters are not LoRA", file=sys.stderr)
        return 1
    scale = float(config['lora_parameters']['scale'])
    adapters = mx.load(str(adapters_file))

    weights = {}
    shards = sorted(base.glob('model*.safetensors'))
    if not shards:
        print(f'merge_lora: no safetensors in {base}', file=sys.stderr)
        return 1
    for shard in shards:
        weights.update(mx.load(str(shard)))

    modules = sorted({k[: -len('.lora_a')] for k in adapters if k.endswith('.lora_a')})
    merged = 0
    for module in modules:
        a = adapters[f'{module}.lora_a'].astype(mx.float32)  # [in, r]
        b = adapters[f'{module}.lora_b'].astype(mx.float32)  # [r, out]
        if not module.startswith('language_model.model.'):
            print(f'merge_lora: unexpected adapter module {module}', file=sys.stderr)
            return 1
        name = 'model.language_model.' + module[len('language_model.model.') :] + '.weight'
        if name not in weights:
            print(f'merge_lora: {module} has no weight {name} in the base', file=sys.stderr)
            return 1
        w = weights[name]
        delta = (scale * (a @ b)).T  # [out, in]
        if tuple(delta.shape) != tuple(w.shape):
            print(f'merge_lora: {name} is {w.shape}, the LoRA delta {delta.shape}', file=sys.stderr)
            return 1
        weights[name] = w.astype(mx.float32) + delta
        merged += 1

    out.mkdir(parents=True, exist_ok=True)
    for f in base.iterdir():
        if f.is_file() and ((not f.name.startswith('model') and f.suffix in ('.json', '.jinja', '.txt')) or f.name in ('LICENSE', 'README.md')):
            shutil.copy2(f, out / f.name)
    mx.eval(weights)
    mx.save_safetensors(str(out / 'model.safetensors'), weights, metadata={'format': 'pt'})
    (out / 'merge.json').write_text(
        json.dumps(
            {'base': str(base), 'adapters': str(adapters_file), 'config': str(config_file), 'scale': scale, 'rank': config['lora_parameters']['rank'], 'merged_modules': merged, 'tensors': len(weights)},
            indent=2,
        )
        + '\n'
    )
    print(f'merge_lora: {merged} layers merged (scale {scale}), {len(weights)} tensors -> {out}/model.safetensors')
    return 0


if __name__ == '__main__':
    sys.exit(main())
